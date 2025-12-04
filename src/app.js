import axios from "axios";
import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";
import { connectDB, getDB } from "./db.js";
import cos from "./cos.js";
import multer from "multer";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 格式化 joinDate 值
const formatJoinDateValue = (value) => {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// 省份名称规范化：去掉“省/市/自治区”等后缀
const normalizeProvinceName = (raw = "") => {
  return String(raw)
    .trim()
    .replace(/(省|市|特别行政区|壮族自治区|回族自治区|维吾尔自治区)$/u, "");
};

// 让 Express 能解析 JSON 请求体
app.use(express.json());

// 让 Express 识别微信小程序上传的 multipart/form-data
const upload = multer({
  storage: multer.memoryStorage() // 文件放在内存 buffer 里，方便直接传 COS
});

// 微信登录：用 code 换 openid，并在数据库里创建/更新用户
app.post("/api/auth/login", async (req, res) => {
  try {
    const { code, userInfo } = req.body;

    if (!code) {
      return res.status(400).json({ error: "code is required" });
    }

    const appid = process.env.WECHAT_APPID;
    const secret = process.env.WECHAT_SECRET;

    // 1. 调用微信 jscode2session
    // 后端用 code 去请求微信的 jscode2session拿到 openid / session_key
    const wxResp = await axios.get("https://api.weixin.qq.com/sns/jscode2session", {
      params: {
        appid,
        secret,
        js_code: code,
        grant_type: "authorization_code"
      }
    });

    const { openid, session_key, errcode, errmsg } = wxResp.data;

    if (!openid) {
      console.error("wechat login error:", wxResp.data);
      return res.status(400).json({
        error: "wechat login failed",
        detail: errmsg || "no openid"
      });
    } else if (errcode) {
      console.error("wechat login error:", wxResp.data);
      return res.status(400).json({
        error: "wechat login failed",
        detail: errmsg || `errcode: ${errcode}`
      });
    }

    const db = getDB();
    const users = db.collection("users");

    // 2. upsert 用户信息
    // 用 openid 在 MongoDB 里 upsert 用户：
    //   如果是新用户：插入一条记录（含 openid, createdAt 等）
    //   老用户：更新头像、昵称等
    const now = new Date();

    const baseProfile = {
      nickname: userInfo?.nickName || "",
      avatarUrl: userInfo?.avatarUrl || "",
      gender: typeof userInfo?.gender === "number" ? userInfo.gender : 0,
      sessionKey: session_key || "",
      updatedAt: now
    };

    const result = await users.findOneAndUpdate(
      { openid },
      {
        // 只在“第一次插入”时生效
        $setOnInsert: {
          createdAt: now,
          joinDate: now, // 首次登录时间
          openid
        },
        // 每次登录都更新的字段
        $set: baseProfile
      },
      {
        upsert: true,
        returnDocument: "after" // 老 driver: returnOriginal: false
      }
    );

    // 兜底：有些 driver 拿不到 value，就查一次
    let user = result.value;
    if (!user) {
      user = await users.findOne({ openid });
    }
    if (!user) {
      console.error("login: upsert user but cannot read back", { openid });
      return res.status(500).json({ error: "failed to create user" });
    }

    // 兼容“旧数据没有 joinDate”的情况（比如你上线 joinDate 字段之前）
    if (!user.joinDate) {
      const joinDate = user.createdAt || now;
      await users.updateOne({ _id: user._id }, { $set: { joinDate } });
      user.joinDate = joinDate;
    }

    const joinDateDisplay = formatJoinDateValue(user.joinDate || user.createdAt || now);

    // 现在 user 一定存在了，才能安全访问 _id
    // 生成一个 JWT token，里面带：
    //     userId
    //     openid
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        openid
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    // 返回给前端
    res.json({
      token,
      user: {
        id: user._id,
        openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        username: user.username || user.nickname || "",
        userAvatar: user.userAvatar || user.avatarUrl || "",
        joinDate: joinDateDisplay
      }
    });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// 获取当前用户个人信息
app.get("/api/profile", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const users = db.collection("users");

    const user = await users.findOne({ _id: new ObjectId(req.user.userId) });

    if (!user) {
      return res.status(404).json({ error: "user not found" });
    }

    res.json({
      nickname: user.nickname || "",
      avatarUrl: user.avatarUrl || "",
      username: user.username || "",
      userAvatar: user.userAvatar || "",
      gender: user.gender ?? 0,
      deliveryDate: user.deliveryDate || "",
      favoriteCarModel: user.favoriteCarModel || "",
      phone: user.phone || "",
      email: user.email || "",
      joinDate: formatJoinDateValue(user.joinDate || user.createdAt || "")
    });
  } catch (err) {
    console.error("GET /api/profile error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// 更新当前用户个人信息
app.put("/api/profile", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const users = db.collection("users");

    const { username, userAvatar, gender, deliveryDate, favoriteCarModel, phone, email } = req.body;

    const update = {
      updatedAt: new Date()
    };

    if (username != null) update.username = username;
    if (userAvatar != null) update.userAvatar = userAvatar;
    if (gender != null) update.gender = Number(gender);
    if (deliveryDate != null) update.deliveryDate = deliveryDate;
    if (favoriteCarModel != null) update.favoriteCarModel = favoriteCarModel;
    if (phone != null) update.phone = phone;
    if (email != null) update.email = email;

    await users.updateOne({ _id: new ObjectId(req.user.userId) }, { $set: update });

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /api/profile error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// 上传头像
app.post("/api/upload/avatar", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const userId = req.user.userId;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "no file" });
    }

    // 1. 上传头像到 COS
    const { url, key, data } = await uploadAvatarToCOS({
      fileBuffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype
    });

    // 2. 更新用户头像 userAvatar
    const db = getDB();
    const users = db.collection("users");

    await users.updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          userAvatar: url,
          updatedAt: new Date()
        }
      }
    );
    res.json({ success: true, url: url });
  } catch (err) {
    console.error("POST /api/upload/avatar error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// 新增加油记录
app.post("/api/refuels", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const refuels = db.collection("refuels");

    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "no userId in token" });
    }

    // 前端传过来的字段
    const {
      date, // '2025-11-28'
      time, // '22:35'
      odometer, // 里程
      volume, // 加油量(L)
      amount, // 金额(元)
      pricePerL, // 单价(元/L)
      fuelGrade, // 92#/95# ...
      isFullTank, // 是否加满
      warningLight, // 是否亮灯
      hasPreviousRecord, // 上次是否记录
      remark // 备注
    } = req.body;

    // 简单必填校验
    if (
      !date ||
      !time ||
      volume == null ||
      amount == null ||
      pricePerL == null ||
      odometer == null
    ) {
      return res
        .status(400)
        .json({ error: "date, time, odometer, volume, amount, pricePerL are required" });
    }

    const now = new Date();
    // 把 date + time 拼成一个 JS Date（存成本次加油时间）
    const isoString = `${date}T${time}:00`;
    const refuelDate = new Date(isoString);

    const doc = {
      userId,
      refuelDate, // 本次加油时间
      date, // 原始字符串也可以保留
      time,
      odometer: Number(odometer),
      volume: Number(volume),
      amount: Number(amount),
      pricePerL: Number(pricePerL),
      fuelGrade: fuelGrade || "",
      isFullTank: !!isFullTank,
      warningLight: !!warningLight,
      hasPreviousRecord: !!hasPreviousRecord,
      remark: remark || "",
      createdAt: now,
      updatedAt: now
    };

    const result = await refuels.insertOne(doc);

    return res.json({
      success: true,
      data: {
        _id: result.insertedId,
        ...doc
      }
    });
  } catch (err) {
    console.error("POST /api/refuels error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// 获取加油记录列表
app.get("/api/refuels/list", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const refuels = db.collection("refuels");

    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "no userId in token" });
    }

    // year 从 query 里取，没传就用当前年
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);

    // 时间升序查出，当成「行驶轨迹」
    const docs = await refuels
      .find({
        userId,
        refuelDate: { $gte: start, $lt: end }
      })
      .sort({ refuelDate: 1 })
      .toArray();

    // 汇总数据
    let totalAmount = 0; // 总花费（所有记录）
    let totalVolume = 0; // 总加油量（所有记录）

    let totalDistance = 0; // 参与统计的“区间总里程”
    let totalVolumeUsed = 0; // 参与统计的“区间总油量”

    let prev = null; // 上一次加油记录（按时间）

    // 👇 新增：用于计算 “首尾里程差”
    let firstOdometer = null;
    let lastOdometer = null;

    for (const doc of docs) {
      const amountNum = Number(doc.amount || 0);
      const volumeNum = Number(doc.volume || 0);

      totalAmount += amountNum;
      totalVolume += volumeNum;

      // 默认区间数据先清空
      doc.distance = null;
      doc.lPer100km = null;
      doc.pricePerKm = null;

      // 记录首尾 odometer
      if (doc.odometer != null) {
        const odo = Number(doc.odometer);
        if (firstOdometer === null) {
          firstOdometer = odo; // 第一条
        }
        lastOdometer = odo; // 不断覆盖，最终是最后一条
      }

      // 需要：当前 & 上一次 都有合法 odometer，并且当前 > 上一次
      if (prev && doc.odometer != null && prev.odometer != null) {
        const currOdo = Number(doc.odometer);
        const prevOdo = Number(prev.odometer);
        const dist = currOdo - prevOdo;

        if (dist > 0) {
          // 区间里程
          doc.distance = dist;
          totalDistance += dist;

          // 区间油耗：用“当前这次加了多少升”来算上一段路
          if (volumeNum > 0) {
            const l100 = (volumeNum / dist) * 100;
            doc.lPer100km = Number(l100.toFixed(2));

            totalVolumeUsed += volumeNum;
          }

          // 区间单公里成本：当前这次花的钱 / 这一段跑的里程
          if (amountNum > 0) {
            const pricePerKm = amountNum / dist;
            doc.pricePerKm = Number(pricePerKm.toFixed(2));
          }
        }
      }

      prev = doc;
    }

    // 👇 新增：首尾里程差（覆盖里程）
    let coverageDistance = 0;
    if (firstOdometer !== null && lastOdometer !== null && lastOdometer > firstOdometer) {
      coverageDistance = lastOdometer - firstOdometer;
    } else {
      // 没有完整里程数据就退而求其次，用区间总和
      coverageDistance = totalDistance;
    }

    // 加权平均油价：总花费 / 总加油量
    const avgPricePerL = totalVolume > 0 ? Number((totalAmount / totalVolume).toFixed(2)) : 0;

    // 全年平均油耗：总油量 / 总里程 * 100
    const avgFuelConsumption =
      totalDistance > 0 ? Number(((totalVolumeUsed / totalDistance) * 100).toFixed(2)) : 0;

    // 输出给前端的列表（按时间倒序：最近在前）
    const list = docs
      .slice()
      .reverse()
      .map((doc) => {
        const d = doc.refuelDate ? new Date(doc.refuelDate) : new Date();
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const monthDay = `${month}/${day}`;

        return {
          _id: String(doc._id),
          monthDay, // 11/23
          lPer100km: doc.lPer100km, // 区间油耗（可能为 null）
          distance: doc.distance, // 区间里程（可能为 null）
          odometer: doc.odometer ?? null, // 👈 本次加油时仪表盘总里程
          amount: doc.amount ?? null, // 本次加油金额
          pricePerL: doc.pricePerL ?? null, // 单价（元/升）
          volume: doc.volume ?? null, // 加油量（升）
          fuelGrade: doc.fuelGrade ?? "",
          isFullTank: !!doc.isFullTank, // 是否加满
          pricePerKm: doc.pricePerKm ?? null // 区间单公里成本
        };
      });

    return res.json({
      success: true,
      data: {
        summary: {
          year,
          totalAmount: Number(totalAmount.toFixed(2)),
          avgFuelConsumption,
          avgPricePerL,
          totalDistance,
          coverageDistance // 👈 新增：首尾里程差，用来给顶部卡片展示
        },
        records: list
      }
    });
  } catch (err) {
    console.error("GET /api/refuels/list error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// 根据id获取单条加油记录
app.get("/api/refuels/:id", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const refuels = db.collection("refuels");

    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "no userId in token" });
    }

    const _idStr = req.params.id;
    if (!_idStr) {
      return res.status(400).json({ error: "id is required" });
    }

    let _id;
    try {
      // ObjectId("692e4c0bd2674a71f01c0b99") 这样的格式
      _id = new ObjectId(_idStr);
    } catch (e) {
      return res.status(400).json({ error: "invalid id format" });
    }

    const doc = await refuels.findOne({ _id, userId });
    if (!doc) {
      return res.status(404).json({ error: "record not found" });
    }

    return res.json({
      success: true,
      data: doc
    });
  } catch (err) {
    console.error("GET /api/refuels/:id error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// 更新单条加油记录
app.put("/api/refuels/:id", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const refuels = db.collection("refuels");

    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "no userId in token" });
    }

    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "missing id" });
    }

    // 兼容前端 axios.post('/api/refuels', { data: payload }) 这种写法
    const body = req.body && (req.body.data || req.body);

    if (!body) {
      return res.status(400).json({ error: "missing body" });
    }

    const {
      date, // '2025-11-28'
      time, // '22:35'
      odometer, // 里程
      volume, // 加油量(L)
      amount, // 金额(元)
      pricePerL, // 单价(元/L)
      fuelGrade, // 92#/95# ...
      isFullTank, // 是否加满
      warningLight, // 是否亮灯
      hasPreviousRecord,
      remark
    } = body;

    const update = {
      updatedAt: new Date()
    };

    // date + time 拼 refuelDate（有传就更新）
    if (date && time) {
      const isoString = `${date}T${time}:00`;
      update.refuelDate = new Date(isoString); // 本次加油时间
      update.date = date;
      update.time = time;
    }

    if (odometer != null) {
      update.odometer = Number(odometer);
    }
    if (volume != null) {
      update.volume = Number(volume);
    }
    if (amount != null) {
      update.amount = Number(amount);
    }
    if (pricePerL != null) {
      update.pricePerL = Number(pricePerL);
    }
    if (typeof fuelGrade !== "undefined") {
      update.fuelGrade = fuelGrade || "";
    }
    if (typeof isFullTank !== "undefined") {
      update.isFullTank = !!isFullTank;
    }
    if (typeof warningLight !== "undefined") {
      update.warningLight = !!warningLight;
    }
    if (typeof hasPreviousRecord !== "undefined") {
      update.hasPreviousRecord = !!hasPreviousRecord;
    }
    if (typeof remark !== "undefined") {
      update.remark = remark || "";
    }

    // 防止 $set 空对象
    if (Object.keys(update).length <= 1) {
      // 只有 updatedAt
      return res.json({ success: true, data: null });
    }

    const _id = new ObjectId(id);

    // 过滤条件 { _id: new ObjectId(id), userId } 只改自己的数据
    const result = await refuels.updateOne(
      { _id, userId }, // 注意 userId 是字符串，不要 new ObjectId(userId)
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "not found" });
    }

    // 返回最新的文档给前端（可选）
    const doc = await refuels.findOne({ _id, userId });

    return res.json({
      success: true,
      data: doc
    });
  } catch (err) {
    console.error("PUT /api/refuels/:id error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// 删除单条加油记录
app.delete("/api/refuels/:id", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const refuels = db.collection("refuels");

    const userId = req.user.userId;
    const _id = new ObjectId(req.params.id);

    await refuels.deleteOne({ _id, userId });

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/refuels/:id error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// 获取今日油价
app.get("/api/oil-price", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: "no userId in token" });
    }

    const rawProvince = (req.query.province || "").toString().trim();
    if (!rawProvince) {
      return res.status(400).json({ error: "province is required" });
    }

    const province = normalizeProvinceName(rawProvince);

    if (!process.env.OIL_API_URL || !process.env.OIL_APP_ID || !process.env.OIL_APP_SECRET) {
      console.error("OIL_API env missing");
      return res.status(500).json({ error: "oil api not configured" });
    }

    const { data } = await axios.get(process.env.OIL_API_URL, {
      params: {
        province, // 例如：广东
        app_id: process.env.OIL_APP_ID,
        app_secret: process.env.OIL_APP_SECRET
      },
      timeout: 8000
    });

    // 按文档：code === 1 表示成功
    if (data.code !== 1 || !data.data) {
      console.error("mxnzp oil api error:", data);
      return res.status(502).json({
        error: "upstream oil api error",
        detail: data.msg || ""
      });
    }
    const d = data?.data;

    // 统一整理成前端好用的结构
    const prices = [
      { label: "92#", value: d.t92 || "--" },
      { label: "95#", value: d.t95 || "--" },
      { label: "98#", value: d.t98 || "--" },
      { label: "0#", value: d.t0 || "--" },
      { label: "89#", value: d.t89 || "--" }
    ];

    return res.json({
      success: true,
      province: d.province || province,
      prices
    });
  } catch (err) {
    console.error("GET /api/oil-price error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// 鉴权中间件
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return res.status(401).json({ error: "no token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // 把用户信息挂到 req 上，后面接口可以直接用
    req.user = {
      userId: payload.userId,
      openid: payload.openid
    };
    next();
  } catch (err) {
    console.error("auth error:", err);
    return res.status(401).json({ error: "invalid token" });
  }
}

// 上传头像到COS
function uploadAvatarToCOS({ fileBuffer, fileName, mimeType }) {
  return new Promise((resolve, reject) => {
    const Bucket = process.env.TENCENT_COS_BUCKET;
    const Region = process.env.TENCENT_COS_REGION;

    // 存在 COS 里的路径：avatar/xxxxxx.jpg
    const ext = mimeType.split("/")[1] || "jpg";
    const key = `avatar/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

    cos.putObject(
      {
        Bucket,
        Region,
        Key: key,
        Body: fileBuffer,
        ContentLength: fileBuffer.length,
        ContentType: mimeType
      },
      (err, data) => {
        if (err) {
          console.error("COS 上传失败：", err);
          return reject(err);
        }

        // 生成公网访问 URL（默认域名格式）
        const url = `https://${Bucket}.cos.${Region}.myqcloud.com/${key}`;
        resolve({ url, key, data });
      }
    );
  });
}

// Connect to MongoDB first, then start the HTTP server so the process stays alive.
async function startServer() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server ready at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
