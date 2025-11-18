// src/db.js 负责连接 MongoDB
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("❌ 请在 .env 中配置 MONGODB_URI");
}

const client = new MongoClient(uri);
let db;

// 连接 MongoDB，只在服务启动时调用一次
export async function connectDB() {
  if (db) return db;

  try {
    await client.connect();
    // 这里指定一个数据库名字，比如 car_fuel（不存在会自动创建）
    db = client.db("car_fuel");

    console.log("✅ MongoDB connected");
    return db;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    throw err;
  }
}

// 在已连接后获取 db 实例
export function getDB() {
  if (!db) {
    throw new Error("Database not initialized. 请先调用 connectDB()");
  }
  return db;
}
