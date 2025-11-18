import axios from "axios";
import jwt from "jsonwebtoken";
import { getDB } from "./db.js";

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
    const wxResp = await axios.get(
      "https://api.weixin.qq.com/sns/jscode2session",
      {
        params: {
          appid,
          secret,
          js_code: code,
          grant_type: "authorization_code"
        }
      }
    );

    const { openid, session_key, errcode, errmsg } = wxResp.data;

    if (!openid) {
      console.error("wechat login error:", wxResp.data);
      return res.status(400).json({
        error: "wechat login failed",
        detail: errmsg || "no openid"
      });
    }

    const db = getDB();
    const users = db.collection("users");

    // 2. upsert 用户信息
    const now = new Date();

    const baseProfile = {
      nickname: userInfo?.nickName || "",
      avatarUrl: userInfo?.avatarUrl || "",
      gender: typeof userInfo?.gender === "number" ? userInfo.gender : 0,
      updatedAt: now
    };

    const result = await users.findOneAndUpdate(
      { openid },
      {
        $setOnInsert: { createdAt: now },
        $set: baseProfile
      },
      {
        upsert: true,
        returnDocument: "after"
      }
    );

    const user = result.value;

    // 3. 签发 token（里面带 userId / openid）
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        openid
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl
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
      gender: user.gender ?? 0,
      deliveryDate: user.deliveryDate || "",
      favoriteCarModel: user.favoriteCarModel || "",
      phone: user.phone || "",
      email: user.email || ""
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

    const {
      nickname,
      avatarUrl,
      gender,
      deliveryDate,
      favoriteCarModel,
      phone,
      email
    } = req.body;

    const update = {
      updatedAt: new Date()
    };

    if (nickname != null) update.nickname = nickname;
    if (avatarUrl != null) update.avatarUrl = avatarUrl;
    if (gender != null) update.gender = Number(gender);
    if (deliveryDate != null) update.deliveryDate = deliveryDate;
    if (favoriteCarModel != null) update.favoriteCarModel = favoriteCarModel;
    if (phone != null) update.phone = phone;
    if (email != null) update.email = email;

    await users.updateOne(
      { _id: new ObjectId(req.user.userId) },
      { $set: update }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /api/profile error:", err);
    res.status(500).json({ error: "server error" });
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
