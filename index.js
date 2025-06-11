require("dotenv").config();
const AWS = require("aws-sdk");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Client, GatewayIntentBits } = require("discord.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const GUILD_ID = process.env.GUILD_ID;
const TABLE_NAME = "VoiceChannelMembers";
const docClient = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const getKSTNow = () => dayjs().tz("Asia/Seoul");
const formatKST = (d = getKSTNow()) => d.format("YYYY-MM-DD HH:mm:ss");
const formatDate = () => getKSTNow().format("YYYY-MM-DD");

// username: 이름 맵
const USER_MAP = {
  eunjin3395: "은진",
  rimi_lim: "효림",
  kslvy: "경은",
  j11gen: "성윤",
};

// Attendance 테이블 joinedAt 기록
const updateJoinedAt = async (username) => {
  const today = formatDate();
  const now = getKSTNow();

  if (now.isBefore(now.startOf("day").add(6, "hour"))) return;

  const formattedNow = formatKST(now);

  const params = {
    TableName: "Attendance",
    Key: { date: today, username },
    UpdateExpression: "SET joinedAt = if_not_exists(joinedAt, :now)",
    ExpressionAttributeValues: {
      ":now": formattedNow,
    },
    ConditionExpression: "attribute_not_exists(joinedAt)",
  };

  try {
    await docClient.update(params).promise();
    console.log(`[✔] joinedAt 기록 완료: ${username} - ${formattedNow}`);
  } catch (e) {
    if (e.code === "ConditionalCheckFailedException") {
      console.log(`[ℹ] 이미 joinedAt 기록됨: ${username}`);
    } else {
      console.error("❌ joinedAt 업데이트 오류:", e);
    }
  }
};

// Discord 봇 설정
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;
  const username = newState.member?.user?.username;
  const now = formatKST();

  if (!username) return;

  try {
    if (oldChannel && oldChannel !== newChannel) {
      await docClient.delete({ TableName: TABLE_NAME, Key: { username } }).promise();
      console.log(`[퇴장] ${username} from ${oldChannel} at ${now}`);
    }

    if (newChannel && newChannel !== oldChannel) {
      await docClient
        .put({
          TableName: TABLE_NAME,
          Item: { username, joinedAt: now },
        })
        .promise();
      console.log(`[입장] ${username} to ${newChannel} at ${now}`);

      await updateJoinedAt(username);
    }
  } catch (err) {
    console.error("❌ DynamoDB 처리 오류:", err);
  }
});

client.once("ready", async () => {
  console.log(`${client.user.tag} 봇이 실행되었습니다.`);
  const guild = await client.guilds.fetch(GUILD_ID);
  const members = await guild.members.fetch();
  members.forEach((member) => console.log(`${member.user.username} (${member.user.id})`));
  console.log(`✅ 총 ${members.size}명의 멤버를 조회했습니다.`);
});

client.login(process.env.DISCORD_TOKEN);
