import axios from "axios";

// 从环境变量获取企业微信机器人 webhook 地址
const WECHAT_ROBOT_WEBHOOK = process.env.WECHAT_ROBOT_WEBHOOK || "";

/**
 * @typedef {Object} FeedbackPayload
 * @property {string} feeling 用户的使用感受
 * @property {string} content 反馈内容
 * @property {string} [contact] 联系方式（可选）
 * @property {string[]} [images] 上传的图片 URL（可选）
 * @property {string} userId 用户 ID
 * @property {string} nickname 用户昵称
 * @property {Object} meta 设备/环境元数据
 * @property {string} meta.page 当前页面
 * @property {string} meta.system 系统类型
 * @property {string} meta.platform 平台（例如：iOS, Android）
 * @property {string} meta.model 设备型号
 * @property {string} meta.brand 设备品牌
 * @property {string} meta.language 系统语言
 * @property {string} meta.screenSize 屏幕大小
 * @property {string} meta.city 城市
 * @property {string} meta.appVersion 应用版本
 * @property {string} meta.clientUserId 客户端用户 ID
 */

/**
 * 把用户反馈发送到企业微信机器人
 * @param {FeedbackPayload} payload
 */
export async function sendFeedbackToWecomRobot(payload) {
  if (!WECHAT_ROBOT_WEBHOOK) return;

  const { feeling, content, contact, images = [], userId, nickname, meta } = payload;

  // 处理 Markdown 格式内容
  const safeContent = content.trim() || "(用户未填写内容)";
  /** @type {string[]} */
  const lines = [];

  lines.push("**📢 收到新的用户反馈**");
  lines.push("");
  lines.push(`- **用户感受**: **${feeling}**`);
  lines.push(`- **反馈内容**:`);
  lines.push(`> ${safeContent.replace(/\n/g, "\n> ")}`);
  lines.push("");

  // 添加联系方式
  if (contact) {
    lines.push(`- **联系方式**: '${contact}'`);
  }

  // 添加图片链接
  if (images.length > 0) {
    lines.push("- **截图**:");
    images.forEach((img) => {
      lines.push(`  - ![截图](${img})`);
    });
  }

  // 添加元数据（如设备信息等）
  lines.push("");
  lines.push(`- **设备信息**:`);
  lines.push(`  - 页面: ${meta.page}`);
  lines.push(`  - 系统: ${meta.system}`);
  lines.push(`  - 平台: ${meta.platform}`);
  lines.push(`  - 设备型号: ${meta.model}`);
  lines.push(`  - 设备品牌: ${meta.brand}`);
  lines.push(`  - 语言: ${meta.language}`);
  lines.push(`  - 屏幕大小: ${meta.screenSize}`);
  lines.push(`  - 城市: ${meta.city}`);
  lines.push(`  - 应用版本: ${meta.appVersion}`);
  lines.push(`  - 客户端用户 ID: ${meta.clientUserId}`);

  // 构建消息对象
  const message = {
    msgtype: "text", // 发送文本类型消息
    text: {
      content: lines.join("\n") // 拼接所有行文本
    }
  };

  try {
    // 发送请求到企业微信机器人 webhook
    await axios.post(WECHAT_ROBOT_WEBHOOK, message);
  } catch (error) {
    console.error("Error sending feedback to Wecom:", error);
  }
}
