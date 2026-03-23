import http from 'http';

// Render-এর হেলথ চেক পাসের জন্য ছোট একটি সার্ভার
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('SBMC Library Bot is Running!');
}).listen(process.env.PORT || 8000);

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';

// ==========================================
// 1. CONFIGURATION & SETUP
// ==========================================
const botToken = process.env.BOT_TOKEN;

if (!botToken) {
    throw new Error('Missing BOT_TOKEN in your .env file!');
}

const bot = new Telegraf(botToken);

// Set up the persistent Menu Button
bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'library', description: 'Open the Medical Digital Library' },
    { command: 'help', description: 'Get help with using this bot' }
]);

// ==========================================
// 2. DATABASES (Add your file IDs here)
// ==========================================

// 📖 BOOKS DATABASE
const libraryDatabase = {
    Anatomy: [
        { title: "Netter's Atlas of Human Anatomy", id: "anat_netter", file_id: "YOUR_FILE_ID_HERE" },
        { title: "BD Chaurasia Vol 1", id: "anat_bdc1", file_id: "YOUR_FILE_ID_HERE" }
    ],
    Physiology: [
        { title: "Guyton and Hall", id: "phys_guyton", file_id: "YOUR_FILE_ID_HERE" }
    ],
    Biochem: [], Microbio: [], Pathology: [], Pharma: [], Forensic: []
};

// 📊 SLIDES DATABASE (Nested: Teacher -> Topic -> Files)
const slidesDatabase = {
    Anatomy: [
        {
            teacherName: "Dr. Hasan",
            teacherId: "t_hasan",
            topics: [
                {
                    topicName: "Upper Limb",
                    topicId: "top_ana_ul",
                    files: ["YOUR_FILE_ID_1", "YOUR_FILE_ID_2"]
                },
                {
                    topicName: "Thorax",
                    topicId: "top_ana_th",
                    files: ["YOUR_FILE_ID_3"]
                }
            ]
        },
        {
            teacherName: "Dr. Ayesha",
            teacherId: "t_ayesha",
            topics: [
                {
                    topicName: "Histology Intro",
                    topicId: "top_ana_his",
                    files: ["YOUR_FILE_ID_4"]
                }
            ]
        }
    ],
    Physiology: [], Biochem: [], Microbio: [], Pathology: [], Pharma: [], Forensic: []
};

// ==========================================
// 3. BASIC COMMANDS & UTILITIES
// ==========================================
bot.start((ctx) => {
    ctx.reply('Welcome to the SBMC Digital Library! 🏛\n\nType /library or click the menu button below to access all medical books and slides.');
});

bot.help((ctx) => {
    const helpText = `
👋 <b>SBMC Digital Library Bot-এ আপনাকে স্বাগতম!</b>

এই বটটির মাধ্যমে আপনি শেরেবাংলা মেডিকেল কলেজের সব দরকারী বই ও স্লাইড সহজেই ডাউনলোড করতে পারবেন।

📚 <b>কীভাবে ব্যবহার করবেন:</b>
/library - এই কমান্ডটি দিলে সাবজেক্টের লিস্ট চলে আসবে (Anatomy, Physiology ইত্যাদি)। সেখান থেকে আপনি প্রয়োজনীয় Books বা Slides বেছে নিতে পারবেন।

👨‍💻 <b>ডেভেলপার:</b> Abdullah Al Arafat
    `;
    ctx.reply(helpText, { parse_mode: 'HTML' });
});

// Utility: Catch file_ids for any document sent to the bot
bot.on('document', (ctx) => {
    const fileId = ctx.message.document.file_id;
    ctx.reply(`Here is your file_id:\n\n<code>${fileId}</code>`, { parse_mode: 'HTML' });
    console.log('File ID caught:', fileId);
});

// ==========================================
// 4. MEDICAL LIBRARY SYSTEM (/library)
// ==========================================
const libraryMenuMarkup = Markup.inlineKeyboard([
    [Markup.button.callback('🦴 Anatomy', 'lib_Anatomy'), Markup.button.callback('🫀 Physiology', 'lib_Physiology')],
    [Markup.button.callback('🧬 Biochemistry', 'lib_Biochem'), Markup.button.callback('🦠 Microbiology', 'lib_Microbio')],
    [Markup.button.callback('🔬 Pathology', 'lib_Pathology'), Markup.button.callback('💊 Pharmacology', 'lib_Pharma')],
    [Markup.button.callback('⚖️ Forensic Med', 'lib_Forensic')]
]);

bot.command('library', async (ctx) => {
    await ctx.reply('🏛 <b>SBMC Digital Library</b>\n\nSelect a department:', {
        parse_mode: 'HTML', ...libraryMenuMarkup
    });
});

bot.action(/lib_(.+)/, async (ctx) => {
    const subject = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📚 <b>${subject} Department</b>\n\nWhat would you like to access?`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📖 Books', `get_books_${subject}`), Markup.button.callback('🖼 Slides', `get_slides_${subject}`)],
            [Markup.button.callback('🔙 Back to Departments', 'back_to_library')]
        ])
    });
});

bot.action('back_to_library', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('🏛 <b>SBMC Digital Library</b>\n\nSelect a department:', {
        parse_mode: 'HTML', ...libraryMenuMarkup
    });
});

// ==========================================
// 4.1 BOOKS LOGIC
// ==========================================
bot.action(/get_books_(.+)/, async (ctx) => {
    const subject = ctx.match[1];
    const booksForSubject = libraryDatabase[subject];
    await ctx.answerCbQuery();

    if (!booksForSubject || booksForSubject.length === 0) {
        return ctx.editMessageText(`Sorry, no books have been uploaded for ${subject} yet!`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `lib_${subject}`)]])
        });
    }

    const bookButtons = booksForSubject.map(book => [Markup.button.callback(`📖 ${book.title}`, `download_${book.id}`)]);
    bookButtons.push([Markup.button.callback('🔙 Back', `lib_${subject}`)]);

    await ctx.editMessageText(`📚 <b>${subject} Books</b>\n\nSelect a book to download:`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard(bookButtons)
    });
});

bot.action(/download_(.+)/, async (ctx) => {
    const requestedBookId = ctx.match[1];
    await ctx.answerCbQuery('Sending file...');

    let fileIdToSend = null;
    let bookTitle = null;

    for (const subject in libraryDatabase) {
        const foundBook = libraryDatabase[subject].find(b => b.id === requestedBookId);
        if (foundBook) {
            fileIdToSend = foundBook.file_id;
            bookTitle = foundBook.title;
            break;
        }
    }

    if (fileIdToSend && fileIdToSend !== "YOUR_FILE_ID_HERE") {
        await ctx.replyWithDocument(fileIdToSend, { caption: `Here is ${bookTitle}` });
    } else {
        await ctx.reply('⚠️ Sorry, the file for this book has not been added yet.');
    }
});

// ==========================================
// 4.2 SLIDES LOGIC (Teachers -> Topics -> Files)
// ==========================================
bot.action(/get_slides_(.+)/, async (ctx) => {
    const subject = ctx.match[1];
    const teachers = slidesDatabase[subject];
    await ctx.answerCbQuery();

    if (!teachers || teachers.length === 0) {
        return ctx.editMessageText(`Sorry, no slides have been uploaded for ${subject} yet!`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `lib_${subject}`)]])
        });
    }

    const teacherButtons = teachers.map(teacher => [Markup.button.callback(`👨‍🏫 ${teacher.teacherName}`, `stchr_${subject}_${teacher.teacherId}`)]);
    teacherButtons.push([Markup.button.callback('🔙 Back to Subject', `lib_${subject}`)]);

    await ctx.editMessageText(`🖼 <b>${subject} Slides</b>\n\nSelect a Teacher:`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard(teacherButtons)
    });
});

bot.action(/^stchr_([^_]+)_(.+)$/, async (ctx) => {
    const subject = ctx.match[1];
    const teacherId = ctx.match[2];
    await ctx.answerCbQuery();

    const teacher = slidesDatabase[subject].find(t => t.teacherId === teacherId);

    if (!teacher || teacher.topics.length === 0) {
        return ctx.editMessageText(`No topics available for ${teacher ? teacher.teacherName : 'this teacher'} yet.`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Teachers', `get_slides_${subject}`)]])
        });
    }

    const topicButtons = teacher.topics.map(topic => [Markup.button.callback(`📑 ${topic.topicName}`, `stopic_${topic.topicId}`)]);
    topicButtons.push([Markup.button.callback('🔙 Back to Teachers', `get_slides_${subject}`)]);

    await ctx.editMessageText(`👨‍🏫 <b>${teacher.teacherName}</b> (${subject})\n\nSelect a Topic:`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard(topicButtons)
    });
});

bot.action(/^stopic_(.+)$/, async (ctx) => {
    const requestedTopicId = ctx.match[1];
    await ctx.answerCbQuery('Preparing your slides...');

    let foundTopic = null;

    for (const subject in slidesDatabase) {
        for (const teacher of slidesDatabase[subject]) {
            const topic = teacher.topics.find(t => t.topicId === requestedTopicId);
            if (topic) {
                foundTopic = topic;
                break;
            }
        }
        if (foundTopic) break;
    }

    if (foundTopic && foundTopic.files.length > 0) {
        await ctx.reply(`Here are the slides for: <b>${foundTopic.topicName}</b> 👇`, { parse_mode: 'HTML' });

        for (const fileId of foundTopic.files) {
            try {
                if (!fileId.includes("YOUR_FILE_ID")) {
                    await ctx.replyWithDocument(fileId);
                }
            } catch (error) {
                console.error('File sending failed:', error.message);
            }
        }
    } else {
        await ctx.reply('⚠️ Sorry, no slide files found for this topic yet.');
    }
});

// ==========================================
// 5. FALLBACK & ERROR HANDLING (Must be at the very bottom!)
// ==========================================

// Fallback for simple text messages (Moved to the bottom!)
bot.on('text', (ctx) => {
    const text = ctx.message.text;
    if (!text.startsWith('/')) {
        ctx.reply('I am a dedicated Library Bot. 🏛\n\nPlease use the /library command to browse books and slides!');
    }
});

bot.catch((err, ctx) => {
    console.error(`[Bot Error] for ${ctx.updateType}:`, err.message);
});

bot.launch()
    .then(() => console.log('✅ Library Bot successfully started!'))
    .catch((err) => console.error('❌ Failed to connect to Telegram.', err.message));

// Enable Graceful Stops
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));