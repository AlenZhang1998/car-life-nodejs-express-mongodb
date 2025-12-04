# Car Life Node.js API

基于 Express + MongoDB 的微信小程序后端，覆盖登录、用户档案、头像上传（腾讯云 COS）、加油记录与油价查询，可直接接入车生活类小程序。

## 功能亮点

- 微信 `jscode2session` 登录：用小程序 `code` 换取 `openid`，自动 upsert 用户，并返回 JWT。
- 用户档案：查询/更新昵称、头像、交付日期、联系方式、喜好车型等字段，自动补齐 `joinDate`。
- 头像上传：`multer` 解析小程序的 `multipart/form-data`，上传至腾讯云 COS，回写 `userAvatar`。
- 加油记录：新增/更新/删除/查询列表与单条，支持 3m/6m/1y/all 等区间过滤，计算区间里程、百公里油耗、单公里成本，以及首尾里程覆盖数。
- 今日油价：按省份查询，统一返回 92#/95#/98#/0#/89# 的油价列表。
- 启动前先连 MongoDB，连接失败直接退出，避免服务假启动。

## 运行要求

- Node.js 18+
- 可访问的 MongoDB 实例
- 微信小程序 AppID/Secret、腾讯云 COS Key/Region/Bucket

## 快速开始

```bash
npm install
# 按下方示例创建 .env

npm run dev   # 本地开发（nodemon）
npm start     # 生产/正式运行
```

服务启动时会先调用 `connectDB()`，MongoDB 连不上会直接终止进程。

## 环境变量示例（.env）

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

# （可选）油价查询 API
OIL_API_URL=https://www.mxnzp.com/api/oil/price/province
OIL_APP_ID=xxxx
OIL_APP_SECRET=xxxx
```

## API 总览（主要入口 `src/app.js`）

| Method | Path                   | 说明                                         |
| ------ | ---------------------- | -------------------------------------------- |
| POST   | `/api/auth/login`      | 微信登录，返回 JWT 与基础用户信息            |
| GET    | `/api/profile`         | 获取当前登录用户档案                         |
| PUT    | `/api/profile`         | 更新档案字段                                 |
| POST   | `/api/upload/avatar`   | 上传头像到 COS，更新 `userAvatar`            |
| POST   | `/api/refuels`         | 新增加油记录                                 |
| GET    | `/api/refuels/list`    | 加油记录列表与汇总（按年份或 3m/6m/1y/all）   |
| GET    | `/api/refuels/:id`     | 按 id 获取单条加油记录                       |
| PUT    | `/api/refuels/:id`     | 按 id 更新加油记录（支持 body 或 body.data） |
| DELETE | `/api/refuels/:id`     | 删除加油记录                                 |
| GET    | `/api/oil-price`       | 按省份查询今日油价                           |

> 除登录外，其余接口均需 `Authorization: Bearer <token>`。

### 登录 `POST /api/auth/login`

请求示例：
```json
{
  "code": "wx.login 拿到的 code",
  "userInfo": {
    "nickName": "小明",
    "avatarUrl": "https://..."
  }
}
```
返回 JWT 与用户信息（包含格式化后的 `joinDate`）。

### 用户档案

- `GET /api/profile`：返回昵称、头像、性别、交付日期、喜好车型、手机号、邮箱等字段。
- `PUT /api/profile`：仅更新传入的字段，例如：
```json
{
  "username": "Alan",
  "favoriteCarModel": "Model Y",
  "deliveryDate": "2023-09-20",
  "phone": "13800000000"
}
```

### 上传头像 `POST /api/upload/avatar`

- Header：`Content-Type: multipart/form-data`
- 表单字段：`file`
- 成功后返回可公网访问的 COS URL，并写入用户 `userAvatar`。

### 加油记录

- `POST /api/refuels`：必填 `date/time/odometer/volume/amount/pricePerL`，其余字段可选。示例：
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
- `GET /api/refuels/list`：`year` query 可选，默认当前年份。返回 `summary` + `records`，含：
  - `distance`：与上一条记录的里程差（区间里程）
  - `lPer100km`：上一段路的百公里油耗（基于当前加油量）
  - `pricePerKm`：上一段路的平均单公里成本
  - `coverageDistance`：本年首尾里程差（无完整里程时回退为区间总和）
- `GET /api/refuels/:id`：获取单条记录详情。
- `PUT /api/refuels/:id`：更新单条记录；`date + time` 会同时更新 `refuelDate`，请求体可为 `{ ... }` 或 `{ "data": { ... } }`。
- `DELETE /api/refuels/:id`：删除当前用户的指定记录。

#### 列表 & 汇总 `GET /api/refuels/list`

- 支持 query `range`：`3m` / `6m` / `1y` / `all`，默认按 `year`（不传则当前年份）。
- 响应 `summary` 含：
  - `totalAmount`：总花费
  - `avgFuelConsumption`：平均油耗（升/100km）
  - `avgPricePerL`：加权平均油价（元/升）
  - `totalDistance`：区间累计里程（基于相邻 odometer 的差值）
  - `coverageDistance`：首尾 odometer 差（缺失时回退为 `totalDistance`）
  - `startDate` / `endDate` / `dateRangeDays`

### 今日油价 `GET /api/oil-price`

- Query：`province`（必填，例：`广东`，会自动去掉“省/市”后缀）。
- 需要配置 `OIL_API_URL`、`OIL_APP_ID`、`OIL_APP_SECRET`。
- 返回 `prices` 数组：`[{ label: "92#", value: "7.42" }, ...]`。

### 调试版入口（可选）

`src/app-test.js` 为一个不带鉴权的精简版本，包含 `/health`、无权限的加油记录增删查接口，方便本地调试与回归。

## 代码位置

- `src/app.js`：主服务入口，路由与业务逻辑集中在此。
- `src/db.js`：MongoDB 连接封装，启动前必须先 `connectDB()`。
- `src/cos.js`：腾讯云 COS SDK 初始化。
