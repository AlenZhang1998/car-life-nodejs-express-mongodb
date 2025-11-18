# 创建项目与依赖

npm init -y
npm i express dotenv cors helmet morgan jsonwebtoken mongoose axios
npm i -D nodemon

在 package.json 加开发脚本：
{
  "type": "module",
  "scripts": {
    "dev": "nodemon src/app.js",
    "start": "node src/app.js"
  }
}