require("dotenv").config();
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Client, GatewayIntentBits } = require("discord.js");
const AWS = require("aws-sdk");
const GUILD_ID = process.env.GUILD_ID;

const USER_MAP = {
  "816901315849879562": "은진",
};

// id: 이름
// 816901315849879562: 은진
//

dayjs.extend(utc);
dayjs.extend(timezone);

// AWS 설정
const dynamo = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const TABLE_NAME = "VoiceChannelMembers";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;
  const userId = newState.id;
  const username = newState.member?.user?.username;
  const now = dayjs().tz("Asia/Seoul").format(); // KST 시간

  try {
    if (oldChannel && oldChannel !== newChannel) {
      await dynamo
        .delete({
          TableName: TABLE_NAME,
          Key: {
            channelId: oldChannel,
            userId: userId,
          },
        })
        .promise();

      console.log(`[퇴장] ${username} (${userId}) from ${oldChannel} at ${now}`);
    }

    if (newChannel && newChannel !== oldChannel) {
      await dynamo
        .put({
          TableName: TABLE_NAME,
          Item: {
            channelId: newChannel,
            userId: userId,
            username: username,
            joinedAt: now,
          },
        })
        .promise()
        .then(() => console.log(`✅ Put 성공 at ${now}`))
        .catch((err) => console.error("❌ Put 실패:", err));

      console.log(`[입장] ${username} (${userId}) to ${newChannel} at ${now}`);
    }
  } catch (err) {
    console.error("DynamoDB 처리 오류:", err);
  }
});

client.once("ready", async () => {
  console.log(`${client.user.tag} 봇이 실행되었습니다.`);

  const guild = await client.guilds.fetch(GUILD_ID);

  // 멤버 캐시를 강제로 모두 불러옴
  const members = await guild.members.fetch(); // returns Collection

  members.forEach((member) => {
    console.log(`${member.user.username} (${member.user.id})`);
  });

  console.log(`✅ 총 ${members.size}명의 멤버를 조회했습니다.`);
});

client.login(process.env.DISCORD_TOKEN);
