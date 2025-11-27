import COS from 'cos-nodejs-sdk-v5'
import dotenv from 'dotenv'

dotenv.config()

const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY
})

export default cos