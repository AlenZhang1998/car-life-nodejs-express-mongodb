# Car Life Node.js API

基于 Express + MongoDB 的小程序后端，包含微信一键登录、用户档案管理、头像上传（腾讯云 COS）以及加油记录等接口，方便快速接入到车生活类小程序中。

## 功能特性
- 微信 `jscode2session` 登录：用 `code` 换取 `openid` 并保存用户基础信息，返回 JWT。
- 用户档案：支持查询与更新昵称、头像、交付日期、联系方式等字段。
- 头像上传：通过 `multer` 解析微信小程序的 `multipart/form-data`，并上传至腾讯云 COS。
- 加油记录：记录时间、里程、油量、油价及备注。
- MongoDB 连接封装，服务启动前确保数据库就绪。

## 技术栈
- Node.js ≥ 18
- Express 5、Multer、Axios
- MongoDB 官方驱动
- jsonwebtoken
- cos-nodejs-sdk-v5
- Nodemon (开发热重载)

## 快速开始
```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（见下文）
cp .env.example .env   # 如果没有示例文件，可直接新建 .env

# 3. 启动
npm run dev     # nodemon，本地开发
npm start       # 生产环境
```

> 服务启动时会自动调用 `connectDB()`，如果连接失败进程会直接退出，确保 MongoDB URI 正确可用。

## 环境变量
在项目根目录创建 `.env`，示例：

```
PORT=3000
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
JWT_SECRET=please_change_me

# 微信
WECHAT_APPID=wx1234567890
WECHAT_SECRET=xxxx

# 腾讯云 COS
TENCENT_COS_SECRET_ID=AKIDxxxxxxxxxxxxx
TENCENT_COS_SECRET_KEY=xxxxxxxxxxxxxxxx
TENCENT_COS_BUCKET=car-life-1250000000
TENCENT_COS_REGION=ap-shanghai
```

## API 速览
| Method | Path | 说明 |
| ------ | ---- | ---- |
| POST | `/api/auth/login` | 微信登录，返回 JWT 与用户信息 |
| GET | `/api/profile` | 获取当前登录用户档案 |
| PUT | `/api/profile` | 更新档案字段 |
| POST | `/api/upload/avatar` | 上传头像至 COS，自动更新 `userAvatar` |
| POST | `/api/refuels` | 新增一条加油记录 |

> `GET/PUT /api/profile`、`POST /api/upload/avatar`、`POST /api/refuels` 均需要 `Authorization: Bearer <token>`。

### 微信登录 `POST /api/auth/login`
```json
{
  "code": "wx.login 拿到的 code",
  "userInfo": {
    "nickName": "小明",
    "avatarUrl": "https://..."
  }
}
```
返回：
```json
{
  "token": "JWT",
  "user": {
    "id": "...",
    "openid": "...",
    "nickname": "小明",
    "joinDate": "2024-11-12"
  }
}
```

### 用户档案
- `GET /api/profile`：返回昵称、头像、性别、交付日期、喜好车型、联系方式等字段。
- `PUT /api/profile`：传入需要更新的字段，例如：

```json
{
  "username": "阿 Alan",
  "favoriteCarModel": "Model Y",
  "deliveryDate": "2023-09-20",
  "phone": "13800000000"
}
```

### 上传头像 `POST /api/upload/avatar`
- Header：`Content-Type: multipart/form-data`
- 表单字段：`file`
- 成功后返回新的可公网访问的 COS URL，并同步更新 `userAvatar` 字段。

### 新增加油记录 `POST /api/refuels`
请求体：
```json
{
  "date": "2025-11-28",
  "time": "22:35",
  "odometer": 15200,
  "volume": 45,
  "amount": 326.7,
  "pricePerL": 7.26,
  "fuelGrade": "92#",
  "isFullTank": true,
  "warningLight": false,
  "hasPreviousRecord": true,
  "remark": "高速服务区加满"
}
```
字段 `date/time/odometer/volume/amount/pricePerL` 为必填。

## 其他说明
- `src/app.js` 为主服务入口；`src/app-test.js` 则是一个更简化的样例（含 `/health`、匿名加油记录接口），可用于调试或回归。
- `src/db.js` 封装 MongoDB 连接，`src/cos.js` 封装 COS SDK 初始化。
- 如果需要扩展更多接口，可直接在 `app.js` 中继续 `app.use(...)` 或拆分路由模块。
