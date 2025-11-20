import axios from "axios";
import express from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";
import { connectDB, getDB } from "./db.js";


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 让 Express 能解析 JSON 请求体
app.use(express.json());

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
        $setOnInsert: {
          createdAt: now,
          openid            // ✅ 顺便把 openid 也写进文档
        },
        $set: baseProfile
      },
      {
        upsert: true,
        // 如果你 driver 比较老，这个才是兼容写法：
        // returnOriginal: false,
        returnDocument: "after"
      }
    );
    
    // 这里做好兜底：有的 driver 不会返回 value
    let user = result.value;
    
    if (!user) {
      // 再查一次，确保拿到用户
      user = await users.findOne({ openid });
    }
    
    if (!user) {
      console.error("login: upsert user but cannot read back", { openid });
      return res.status(500).json({ error: "failed to create user" });
    }
    
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
      username: user.username || "",
      userAvatar: user.userAvatar || "",
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
      username,
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

    if (username != null) update.username = username;
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
