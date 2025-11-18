// src/index.js
import express from "express";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";
import { connectDB, getDB } from "./db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 让 Express 能解析 JSON 请求体
app.use(express.json());

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 获取所有加油记录
app.get("/api/refuels", async (req, res) => {
  try {
    const db = getDB();
    const refuels = await db
      .collection("refuels")
      .find({})
      .sort({ date: -1 })
      .toArray();

    res.json(refuels);
  } catch (err) {
    console.error("GET /api/refuels error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * 新增一条加油记录
 * POST /api/refuels
 * body 示例：
 * {
 *   "date": "2025-11-18",    // 日期字符串
 *   "mileage": 12345,        // 当前公里数
 *   "liters": 40.5,          // 加油升数
 *   "price": 8.2,            // 单价（元/升）
 *   "amount": 332.1,         // 总花费
 *   "note": "加满，深圳宝安某某加油站" // 备注（可选）
 * }
 */
app.post("/api/refuels", async (req, res) => {
  try {
    const db = getDB();
    const data = req.body;

    // 简单校验（可以根据你需求再加）
    if (!data.date || !data.mileage || !data.liters) {
      return res.status(400).json({
        error: "date、mileage、liters 为必填字段"
      });
    }

    const doc = {
      date: data.date,
      mileage: Number(data.mileage),
      liters: Number(data.liters),
      price: data.price != null ? Number(data.price) : null,
      amount: data.amount != null ? Number(data.amount) : null,
      note: data.note || "",
      createdAt: new Date()
    };

    const result = await db.collection("refuels").insertOne(doc);

    res.status(201).json({
      _id: result.insertedId,
      ...doc
    });
  } catch (err) {
    console.error("POST /api/refuels error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * 删除一条加油记录
 * DELETE /api/refuels/:id
 */
app.delete("/api/refuels/:id", async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;

    const result = await db
      .collection("refuels")
      .deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Record not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/refuels/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 启动服务前先连接 MongoDB
async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`🚀 Server is running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
