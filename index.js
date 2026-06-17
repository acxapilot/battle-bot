const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// НАСТРОЙКИ БОТА
const BOT_TOKEN = "8610404547:AAFMIImDTzW1iaV1O_ynLFkLSFCgRM_iAPU"; 
const ADMIN_ID = 8061368956;             

// НАСТРОЙКА КАНАЛОВ
const TARGET_CHANNEL = "@batliarma";     // Куда публикуются пары
const REQUIRED_CHANNEL = "@ARMASHOPSNG"; // Обязательная подписка

const bot = new Telegraf(BOT_TOKEN);
let db;

// Статус авто-батла (включен/выключен админом)
let isAutoBattleActive = false;

// Инициализация базы данных SQLite
async function initDB() {
    db = await open({
        filename: "./database.db",
        driver: sqlite3.Database
    });

    // Очередь тех, кто ждет пару
    await db.exec("CREATE TABLE IF NOT EXISTS queue (user_id INTEGER PRIMARY KEY, username TEXT)");
    // Логи голосования (чтобы один юзер не голосовал дважды в одной паре)
    await db.exec("CREATE TABLE IF NOT EXISTS votes (post_id INTEGER, user_id INTEGER, PRIMARY KEY (post_id, user_id))");

    console.log("База данных успешно инициализирована.");
}

// Функция проверки подписки на обязательный канал
async function checkSubscription(ctx, userId) {
    try {
        const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, userId);
        const validStatuses = ["creator", "administrator", "member"];
        return validStatuses.includes(member.status);
    } catch (error) {
        console.error("Ошибка проверки подписки:", error);
        return false;
    }
}

// Ссылка на бота для кнопки под постом
function getBotLink() {
    const botUsername = bot.botInfo ? bot.botInfo.username : "batliarma_bot";
    return "https://t.me/" + botUsername + "?start=true";
}

// Команда /start для пользователей
bot.start(async (ctx) => {
    try {
        await ctx.reply(
            "Привет! Нажми кнопку ниже для участия в общем батле юзернеймов. Обязательно проверь подписку на наш канал " + REQUIRED_CHANNEL + "!",
            Markup.inlineKeyboard([
                [Markup.button.callback("🔥 Участвовать в батле", "join_queue")]
            ])
        );
    } catch (error) {
        console.error(error);
    }
});

// Обработка кнопки участия в очереди
bot.action("join_queue", async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username ? "@" + ctx.from.username : "id" + userId;

    // 1. Проверка подписки при попытке участвовать
    const isSubscribed = await checkSubscription(ctx, userId);
    if (!isSubscribed) {
        return ctx.answerCbQuery("⚠️ Ошибка: Чтобы участвовать в батле, сначала подпишись на канал " + REQUIRED_CHANNEL + "!", { show_alert: true });
    }

    if (!isAutoBattleActive) {
        return ctx.answerCbQuery("⏳ Батл сейчас закрыт админом. Ожидайте старта!", { show_alert: true });
    }

    try {
        const existing = await db.get("SELECT * FROM queue WHERE user_id = ?", [userId]);
        if (existing) {
            return ctx.answerCbQuery("❌ Вы уже отправили заявку и ждете оппонента!", { show_alert: true });
        }

        // Записываем человека в очередь
        await db.run("INSERT INTO queue (user_id, username) VALUES (?, ?)", [userId, username]);
        await ctx.answerCbQuery("✅ Ты успешно записался в батл! Ищем тебе соперника...", { show_alert: true });

        // ПРОВЕРКА НА АВТО-ПУБЛИКАЦИЮ ПАРЫ
        const participants = await db.all("SELECT * FROM queue LIMIT 2");
        
        // Как только набралось 2 человека — бот сам мгновенно шлет их в канал
        if (participants.length === 2) {
            const u1 = participants[0];
            const u2 = participants[1];

            const name1 = u1.username.replace(/[^a-zA-Z0-9_@]/g, "");
            const name2 = u2.username.replace(/[^a-zA-Z0-9_@]/g, "");

            const textTemplate = "⚔️ ОБЩИЙ БАТЛ ЮЗЕРНЕЙМОВ ⚔️\n\nНовая пара участников сошлась в поединке!\n\n👤 Участник 1: " + name1 + "\n👤 Участник 2: " + name2 + "\n\n👇 Поддержите голосом своего фаворита:";

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.
                    callback("Голосовать за " + name1 + " (0 🗳)", "vote_1:" + name1 + ":0")],
                [Markup.button.callback("Голосовать за " + name2 + " (0 🗳)", "vote_2:" + name2 + ":0")],
                [Markup.button.url("🔥 Тоже участвовать в батле", getBotLink())]
            ]);

            // Публикуем пару в канал
            await ctx.telegram.sendMessage(TARGET_CHANNEL, textTemplate, keyboard);

            // Очищаем этих двоих из очереди, чтобы следующие двое встали на их место
            await db.run("DELETE FROM queue WHERE user_id IN (?, ?)", [u1.user_id, u2.user_id]);
        }

    } catch (error) {
        console.error(error);
        await ctx.answerCbQuery("Произошла ошибка. Попробуйте позже.", { show_alert: true });
    }
});

// Команда /battle для Администратора (Включает или выключает автоматический режим)
bot.command("battle", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    isAutoBattleActive = !isAutoBattleActive;

    if (isAutoBattleActive) {
        await ctx.reply("🚀 Автоматический батл успешно ЗАПУЩЕН! Бот теперь сам будет постить пары в канал " + TARGET_CHANNEL + ", как только будут набегать по 2 участника.");
    } else {
        await ctx.reply("🛑 Автоматический батл ПРИОСТАНОВЛЕН. Новые участники пока не могут регистрироваться.");
    }
});

// Универсальный обработчик кликов голосования под постами
bot.action(/^vote_(1|2):(.+):(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const postId = ctx.callbackQuery.message.message_id;
    const choice = ctx.match[1]; 

    // 2. Проверка подписки при попытке проголосовать
    const isSubscribed = await checkSubscription(ctx, userId);
    if (!isSubscribed) {
        return ctx.answerCbQuery("⚠️ Ошибка: Голосовать могут только подписчики нашего канала " + REQUIRED_CHANNEL + "!", { show_alert: true });
    }

    try {
        const alreadyVoted = await db.get("SELECT * FROM votes WHERE post_id = ? AND user_id = ?", [postId, userId]);
        if (alreadyVoted) {
            return ctx.answerCbQuery("❌ Вы уже отдали свой голос под этим постом!", { show_alert: true });
        }

        await db.run("INSERT INTO votes (post_id, user_id) VALUES (?, ?)", [postId, userId]);

        const oldKeyboard = ctx.callbackQuery.message.reply_markup.inline_keyboard;
        let count1 = parseInt(oldKeyboard[0][0].callback_data.split(":")[2]);
        let count2 = parseInt(oldKeyboard[1][0].callback_data.split(":")[2]);
        const u1_name = oldKeyboard[0][0].callback_data.split(":")[1];
        const u2_name = oldKeyboard[1][0].callback_data.split(":")[1];

        if (choice === "1") count1++;
        if (choice === "2") count2++;

        const updatedKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback("Голосовать за " + u1_name + " (" + count1 + " 🗳)", "vote_1:" + u1_name + ":" + count1)],
            [Markup.button.callback("Голосовать за " + u2_name + " (" + count2 + " 🗳)", "vote_2:" + u2_name + ":" + count2)],
            [Markup.button.url("🔥 Тоже участвовать в батле", getBotLink())]
        ]);

        await ctx.editMessageReplyMarkup(updatedKeyboard.reply_markup);
        await ctx.answerCbQuery("🎉 Твой голос успешно засчитан!", { show_alert: false });

    } catch (error) {
        console.error(error);
        await ctx.answerCbQuery("Ошибка при обработке голоса.", { show_alert: true });
    }
});

// Запуск бота
async function main() {
    await initDB();
    await bot.launch();
    console.log("Бот успешно запущен и готов к работе!");
}

main().catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));