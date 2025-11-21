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

const TABLE_NAME = "VoiceChannelMembers";

const docClient = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// 이름 -> discord id
const USERNAME_TO__DISCORD_ID = {
  // 김은진: "eunjin3395",
  황성윤: "j11gen",
  지현서: "haru_95532",
  이총명: "chong2422",
  김영만: "gimyeongman0658",
  최문형: "invite_me_41",
  김호준: "gimhojun0668",
  이제희: "gimyeongman0658",
};

const DAYOFF_CHANNEL_ID = process.env.DAYOFF_CHANNEL_ID;
const DAYOFF_CHANNEL_ID_2 = "1389951842452246528";
const FORMAT_ERR_MESSAGE = "⚠️ 커맨드 오류: `/휴무 이름 시작일(mmdd) 종료일(mmdd) (휴무 사유)` 형식으로 입력해주세요.";

const getKSTNow = () => dayjs().tz("Asia/Seoul");
const formatKST = (d = getKSTNow()) => d.format("YYYY-MM-DD HH:mm:ss");
const formatDate = () => getKSTNow().format("YYYY-MM-DD");

// Attendance 테이블 joinedAt 기록, discord id 기준
const updateJoinedAt = async (username) => {
  const today = formatDate();
  const now = getKSTNow();

  if (now.isBefore(now.startOf("day").add(5, "hour"))) return;
  if (now.isAfter(now.startOf("day").add(24, "hour"))) return;

  const formattedNow = formatKST(now);

  const params = {
    TableName: "Attendance",
    Key: { date: today, username: username },
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
    throw new Error("유효하지 않은 날짜 범위입니다.");
  }

  const updatePromises = [];

  for (let d = start; d.isSameOrBefore(end); d = d.add(1, "day")) {
    const dateStr = d.format("YYYY-MM-DD");

    const params = {
      TableName: "Attendance",
      Key: { date: dateStr, username: username },
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
            throw new Error(`[⚠️] ${dateStr} - 키가 존재하지 않아 업데이트 실패`);
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
    GatewayIntentBits.MessageContent, // 메시지 내용 접근을 위한 인텐트
  ],
  partials: [Partials.Channel],
});

// 음성 채널에 입장 이벤트 리스너
client.on("voiceStateUpdate", async (oldState, newState) => {
  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;
  const discordId = newState.member?.user?.username;
  const now = formatKST();

  if (!discordId) return;

  try {
    if (oldChannel && oldChannel !== newChannel) {
      await docClient.delete({ TableName: TABLE_NAME, Key: { username: discordId } }).promise();
      console.log(`[퇴장] ${discordId} from ${oldChannel} at ${now}`);
    }

    if (newChannel && newChannel !== oldChannel) {
      await docClient
        .put({
          TableName: TABLE_NAME,
          Item: { username: discordId, joinedAt: now },
        })
        .promise();
      console.log(`[입장] ${discordId} to ${newChannel} at ${now}`);

      await updateJoinedAt(discordId);
    }
  } catch (err) {
    console.error("❌ DynamoDB 처리 오류:", err);
  }
});

client.on("messageCreate", async (message) => {
  // 봇 자기 자신의 메시지는 무시
  if (message.author.bot) return;

  // 특정 채널 ID만 필터링
  if (message.channel.id !== DAYOFF_CHANNEL_ID && message.channel.id != DAYOFF_CHANNEL_ID_2) return;

  // 커맨드 형식 오류
  if (!message.content.startsWith("/휴무")) {
    await message.reply(FORMAT_ERR_MESSAGE);
    return;
  }

  const content = message.content;
  console.log(`[휴무등록 감지] : ${content}`);

  const contentArr = content.trim().split(/\s+/); // 공백 기준 분할

  // 커맨드 형식 오류
  if (contentArr.length < 5) {
    await message.reply(FORMAT_ERR_MESSAGE);
    return;
  }

  try {
    const name = contentArr[1]; // 이름
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

    const discordId = USERNAME_TO__DISCORD_ID[name];
    if (!discordId) {
      await message.reply(`❗ 사용자 \`${name}\`에 대한 정보를 찾을 수 없습니다.`);
      return;
    }

    console.log(`휴무 등록 요청:
- Discord ID: ${discordId}
- 시작일: ${startDate.format("YYYY-MM-DD")}
- 종료일: ${endDate.format("YYYY-MM-DD")}`);

    // DynamoDB에 휴무 반영
    await updateAttendance(discordId, startDate, endDate);
    await message.reply(`✅ 휴무 등록 완료`);
  } catch (err) {
    console.error("❌ 휴무 등록 처리 중 오류:", err.message);
    await message.reply(`❌ 휴무 등록 처리 중 오류: ${err.message}`);
  }
});

client.once("ready", async () => {
  console.log(`${client.user.tag} 봇이 실행되었습니다.`);
});

client.login(process.env.DISCORD_TOKEN);
