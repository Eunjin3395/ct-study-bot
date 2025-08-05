require("dotenv").config();
const AWS = require("aws-sdk");
const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);

const GUILD_ID = process.env.GUILD_ID;
const TABLE_NAME = "VoiceChannelMembers";
const docClient = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const EJ_UID = process.env.EJ_UID;
const SY_UID = process.env.SY_UID;
const HS_UID = process.env.HS_UID;
const HJ_UID = process.env.HJ_UID;
const JW_UID = process.env.JW_UID;

// UID -> Discord ID
const USER_MAP = {
  [EJ_UID]: "eunjin3395",
  [SY_UID]: "j11gen",
  [HS_UID]: "haru_95532",
  [HJ_UID]: "deuue.",
  [JW_UID]: "jujaeweon_41932",
};

const USERNAME_TO_ID = {
  김은진: process.env.EJ_UID,
  황성윤: process.env.SY_UID,
  지현서: process.env.HS_UID,
  이혜준: process.env.HJ_UID,
  주재원: process.env.JW_UID,
};

const DAYOFF_CHANNEL_ID = process.env.DAYOFF_CHANNEL_ID;
const FORMAT_ERR_MESSAGE = "⚠️ 커맨드 오류: `/휴무 @사용자 시작일(mmdd) 종료일(mmdd)` 형식으로 입력해주세요.";

const getKSTNow = () => dayjs().tz("Asia/Seoul");
const formatKST = (d = getKSTNow()) => d.format("YYYY-MM-DD HH:mm:ss");
const formatDate = () => getKSTNow().format("YYYY-MM-DD");

// Attendance 테이블 joinedAt 기록
const updateJoinedAt = async (username) => {
  const today = formatDate();
  const now = getKSTNow();

  if (now.isBefore(now.startOf("day").add(6, "hour"))) return;
  if (now.isAfter(now.startOf("day").add(10, "hour"))) return;

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

// attendance를 dayoff로 업데이트
const updateAttendance = async (username, startDate, endDate) => {
  const start = dayjs(startDate);
  const end = dayjs(endDate);

  if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
    console.error("❌ 유효하지 않은 날짜 범위입니다.");
    return;
  }

  const updatePromises = [];

  for (let d = start; d.isSameOrBefore(end); d = d.add(1, "day")) {
    const dateStr = d.format("YYYY-MM-DD");

    const params = {
      TableName: "Attendance",
      Key: { date: dateStr, username },
      UpdateExpression: "SET attendance = :status",
      ExpressionAttributeValues: {
        ":status": "dayoff",
      },
    };

    updatePromises.push(
      docClient
        .update(params)
        .promise()
        .then(() => console.log(`[✔] ${dateStr} - ${username} 휴무 등록 완료`))
        .catch((err) => {
          if (err.code === "ValidationException") {
            console.error(`[⚠️] ${dateStr} - 키가 존재하지 않아 업데이트 실패`);
          } else {
            console.error(`❌ ${dateStr} - 업데이트 중 오류 발생:`, err);
          }
        })
    );
  }

  await Promise.all(updatePromises);
};

// Discord 봇 설정
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, // 메시지 감지를 위한 인텐트
    GatewayIntentBits.MessageContent, // 메시지 내용 접근을 위한 인텐트!
  ],
  partials: [Partials.Channel],
});

// 음성 채널에 입장 이벤트 리스너
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

client.on("messageCreate", async (message) => {
  // 봇 자기 자신의 메시지는 무시
  if (message.author.bot) return;

  // 특정 채널 ID만 필터링
  const allowedChannelId = DAYOFF_CHANNEL_ID;
  if (message.channel.id !== allowedChannelId) return;

  if (message.content.startsWith("/휴무")) {
    const content = message.content;
    console.log(`[휴무등록 감지] : ${content}`);

    const contentArr = content.trim().split(/\s+/); // 공백 기준 분할

    if (contentArr.length < 4) {
      await message.reply(FORMAT_ERR_MESSAGE);
      return;
    }

    try {
      const mention = contentArr[1]; // <@userId>
      const mmddStart = contentArr[2]; // mmdd
      const mmddEnd = contentArr[3]; // mmdd
      const year = dayjs().year();

      // MMDD 형식 유효성 검증
      const startDate = dayjs(`${year}-${mmddStart.slice(0, 2)}-${mmddStart.slice(2, 4)}`, "YYYY-MM-DD", true);
      const endDate = dayjs(`${year}-${mmddEnd.slice(0, 2)}-${mmddEnd.slice(2, 4)}`, "YYYY-MM-DD", true);

      if (!startDate.isValid() || !endDate.isValid()) {
        await message.reply("⚠️ 날짜 형식 오류: mmdd는 올바른 월/일이어야 합니다 (예: 0705)");
        return;
      }

      // 사용자 입력 처리
      const userInput = contentArr[1];

      // 1. mention 형태 <@1234567890> 또는 <@!1234567890>
      let userId = null;
      const mentionMatch = userInput.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        userId = mentionMatch[1]; // 성공적으로 ID 추출
      } else {
        // 2. 텍스트 멘션 처리: @닉네임
        const usernameMatch = userInput.match(/^@(.+)$/);
        if (usernameMatch) {
          const nickname = usernameMatch[1]; // 예: "kslvy"

          // USERNAME → USER_ID 매핑 (미리 정의해둔 맵 사용)
          userId = USERNAME_TO_ID[nickname];
          if (!userId) {
            await message.reply(`❗ 사용자 \`${nickname}\`에 대한 정보를 찾을 수 없습니다.`);
            return;
          }
        } else {
          await message.reply("⚠️ 사용자 멘션 형식이 잘못되었습니다. `<@id>` 또는 `@닉네임` 형식으로 입력해주세요.");
          return;
        }
      }
      const username = USER_MAP[userId];
      console.log(`휴무 등록 요청:
- 유저 ID: ${userId}
- Discord ID: ${username}
- 시작일: ${startDate.format("YYYY-MM-DD")}
- 종료일: ${endDate.format("YYYY-MM-DD")}`);

      // DynamoDB에 휴무 반영
      await updateAttendance(username, startDate, endDate);
      await message.reply(`✅ 휴무 등록 완료`);
    } catch (err) {
      console.error("❌ 휴무 등록 처리 중 오류:", err);
      await message.reply("❌ 휴무 등록 처리 중 오류 발생");
    }
  } else {
    try {
      await message.reply(FORMAT_ERR_MESSAGE);
    } catch (err) {
      console.error("❌ 휴무 등록 커맨드 안내 중 오류:", err);
    }
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
