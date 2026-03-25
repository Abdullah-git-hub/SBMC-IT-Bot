import http from 'http';
import 'dotenv/config';
import { Telegraf, Markup, session, Scenes, Composer } from 'telegraf';
import mongoose from 'mongoose';

// ==========================================
// 1. WEB SERVER & MONGODB CONNECTION
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('SBMC Library Bot is Running with MongoDB!');
}).listen(process.env.PORT || 8000);

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error('Missing BOT_TOKEN in .env file!');

const bot = new Telegraf(botToken);

// ⚠️ ADMIN IDs
const ADMIN_IDS = [6951331713, 987654321];

// ==========================================
// 2. MONGODB SCHEMAS
// ==========================================
const bookSchema = new mongoose.Schema({ subject: String, category: String, title: String, file_ids: [String] });
const Book = mongoose.model('Book', bookSchema);

const slideSchema = new mongoose.Schema({ subject: String, chapterName: String, file_ids: [String] });
const Slide = mongoose.model('Slide', slideSchema);

const quesSchema = new mongoose.Schema({ batch: String, subject: String, examName: String, file_ids: [String] });
const QuesPaper = mongoose.model('QuesPaper', quesSchema);

const userSchema = new mongoose.Schema({ chatId: { type: Number, unique: true }, firstName: String, joinedAt: { type: Date, default: Date.now } });
const User = mongoose.model('User', userSchema);

const pendingSchema = new mongoose.Schema({
    file_id: String, senderId: Number, senderName: String,
    type: String, subject: String, category: String, batch: String,
    existingId: String, title: String
});
const Pending = mongoose.model('Pending', pendingSchema);

// ==========================================
// 3. HELPER FUNCTIONS & SEARCH
// ==========================================
function getSubjectChunkedButtons(prefix) {
    return [
        [Markup.button.callback('🦴 Anatomy', `${prefix}_Anatomy`), Markup.button.callback('🫀 Physiology', `${prefix}_Physiology`)],
        [Markup.button.callback('🧬 Biochemistry', `${prefix}_Biochemistry`), Markup.button.callback('💊 Pharmacology', `${prefix}_Pharmacology`)],
        [Markup.button.callback('🦠 Microbiology', `${prefix}_Microbiology`), Markup.button.callback('🔬 Pathology', `${prefix}_Pathology`)],
        [Markup.button.callback('⚖️ Forensic', `${prefix}_Forensic`), Markup.button.callback('🌍 Community', `${prefix}_CommunityMed`)],
        [Markup.button.callback('🩺 Medicine', `${prefix}_Medicine`), Markup.button.callback('✂️ Surgery', `${prefix}_Surgery`)],
        [Markup.button.callback('🤰 GyneObs', `${prefix}_GyneObs`)]
    ];
}

const ITEMS_PER_PAGE = 7;
async function performSearch(ctx, query) {
    if (!query || query.length < 2) return ctx.reply('⚠️ অন্তত ২টি অক্ষর লিখে সার্চ করুন।');
    const loadingMsg = await ctx.reply(`🔍 Searching for "<b>${query}</b>"...`, { parse_mode: 'HTML' });

    try {
        const regex = new RegExp(query, 'i');
        const [books, slides, ques] = await Promise.all([
            Book.find({ title: regex }).limit(30), Slide.find({ chapterName: regex }).limit(30), QuesPaper.find({ examName: regex }).limit(30)
        ]);

        const results = [];
        books.forEach(b => results.push({ text: `📖 ${b.title} (${b.subject})`, callback: `dl_book_${b._id}` }));
        slides.forEach(s => results.push({ text: `🖼 ${s.chapterName} (${s.subject})`, callback: `dl_slide_${s._id}` }));
        ques.forEach(q => results.push({ text: `📝 ${q.examName} (Batch ${q.batch} - ${q.subject})`, callback: `dl_qp_${q._id}` }));

        if (results.length === 0) return ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ "<b>${query}</b>" এর জন্য কোনো ফলাফল পাওয়া যায়নি।`, { parse_mode: 'HTML' });

        ctx.session = ctx.session || {}; ctx.session.searchQuery = query; ctx.session.searchResults = results; ctx.session.searchPage = 0;
        await renderSearchPage(ctx, loadingMsg.message_id);
    } catch (error) { ctx.reply('❌ সার্চ করার সময় একটি সমস্যা হয়েছে।'); }
}

async function renderSearchPage(ctx, msgIdToEdit = null) {
    const { searchResults: results, searchPage: page = 0, searchQuery: query } = ctx.session;
    const totalPages = Math.ceil(results.length / ITEMS_PER_PAGE);
    const buttons = results.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE).map(item => [Markup.button.callback(item.text, item.callback)]);

    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', 'page_prev'));
    if (page < totalPages - 1) navButtons.push(Markup.button.callback('Next ➡️', 'page_next'));
    if (navButtons.length > 0) buttons.push(navButtons);

    const text = `✅ "<b>${query}</b>" এর জন্য ${results.length} টি ফলাফল পাওয়া গেছে (পেজ ${page + 1}/${totalPages}):\n\nডাউনলোড করতে ক্লিক করুন:`;
    if (msgIdToEdit) await ctx.telegram.editMessageText(ctx.chat.id, msgIdToEdit, undefined, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    else await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// ==========================================
// 4. WIZARDS (UPLOAD & CONTRIB)
// ==========================================

// --- ADMIN UPLOAD COMPOSER ---
const uploadComposer = new Composer();
uploadComposer.action('up_cancel', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('❌ Upload বাতিল করা হয়েছে।'); return ctx.scene.leave(); });

uploadComposer.action(/up_type_(.+)/, async ctx => {
    ctx.wizard.state.data.type = ctx.match[1]; await ctx.answerCbQuery();
    if (ctx.match[1] === 'ques') {
        const chunked = []; const batches = ['52', '53', '54', '55', '56', '57'].map(b => Markup.button.callback(`Batch ${b}`, `up_batch_${b}`));
        for (let i = 0; i < batches.length; i += 2) chunked.push(batches.slice(i, i + 2));
        chunked.push([Markup.button.callback('❌ Cancel', 'up_cancel')]);
        await ctx.editMessageText('ব্যাচ নির্বাচন করুন:', Markup.inlineKeyboard(chunked));
    } else {
        const chunked = getSubjectChunkedButtons('up_sub'); chunked.push([Markup.button.callback('❌ Cancel', 'up_cancel')]);
        await ctx.editMessageText('সাবজেক্ট নির্বাচন করুন:', Markup.inlineKeyboard(chunked));
    }
});

uploadComposer.action(/up_batch_(.+)/, async ctx => {
    ctx.wizard.state.data.batch = ctx.match[1]; await ctx.answerCbQuery();
    const chunked = getSubjectChunkedButtons('up_sub'); chunked.push([Markup.button.callback('❌ Cancel', 'up_cancel')]);
    await ctx.editMessageText('সাবজেক্ট নির্বাচন করুন:', Markup.inlineKeyboard(chunked));
});

uploadComposer.action(/up_sub_(.+)/, async ctx => {
    const { type, batch } = ctx.wizard.state.data; const subject = ctx.match[1];
    ctx.wizard.state.data.subject = subject; await ctx.answerCbQuery();

    if (type === 'book') {
        await ctx.editMessageText('এটি Main Book নাকি Guide Book?', Markup.inlineKeyboard([[Markup.button.callback('📗 Main Book', 'up_cat_main'), Markup.button.callback('📙 Guide Book', 'up_cat_guide')], [Markup.button.callback('❌ Cancel', 'up_cancel')]]));
    } else if (type === 'slide') {
        const chapters = await Slide.find({ subject });
        const btns = chapters.map(c => [Markup.button.callback(`📑 ${c.chapterName}`, `up_ex_${c._id}`)]);
        btns.push([Markup.button.callback('➕ Add New Chapter', 'up_new')], [Markup.button.callback('❌ Cancel', 'up_cancel')]);
        await ctx.editMessageText(`<b>${subject}</b> এর চ্যাপ্টার সিলেক্ট করুন অথবা নতুন তৈরি করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) });
    } else if (type === 'ques') {
        const exams = await QuesPaper.find({ batch, subject });
        const btns = exams.map(e => [Markup.button.callback(`📄 ${e.examName}`, `up_ex_${e._id}`)]);
        btns.push([Markup.button.callback('➕ Add New Exam', 'up_new')], [Markup.button.callback('❌ Cancel', 'up_cancel')]);
        await ctx.editMessageText(`<b>Batch ${batch} - ${subject}</b> এর এক্সাম সিলেক্ট করুন অথবা নতুন তৈরি করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) });
    }
});

uploadComposer.action(/up_cat_(.+)/, async ctx => { ctx.wizard.state.data.category = ctx.match[1]; await ctx.answerCbQuery(); ctx.wizard.state.awaitingText = true; await ctx.editMessageText('বইটির নাম লিখুন:', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'up_cancel')]])); });
uploadComposer.action('up_new', async ctx => { await ctx.answerCbQuery(); ctx.wizard.state.awaitingText = true; await ctx.editMessageText('নতুন চ্যাপ্টার বা এক্সামের নাম লিখুন:', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'up_cancel')]])); });
uploadComposer.action(/up_ex_(.+)/, async ctx => { ctx.wizard.state.data.existingId = ctx.match[1]; await ctx.answerCbQuery(); ctx.wizard.state.awaitingFile = true; await ctx.editMessageText('✅ সিলেক্ট করা হয়েছে।\n\nএখন ফাইলগুলো সেন্ড করুন। পাঠানো শেষ হলে "Done" বাটনে ক্লিক করুন।', Markup.inlineKeyboard([[Markup.button.callback('✅ Done', 'up_finish'), Markup.button.callback('❌ Cancel', 'up_cancel')]])); });

uploadComposer.on('text', async ctx => {
    if (ctx.message.text === '/cancel') return ctx.scene.leave();
    if (ctx.wizard.state.awaitingText) {
        ctx.wizard.state.data.title = ctx.message.text; ctx.wizard.state.awaitingText = false; ctx.wizard.state.awaitingFile = true;
        await ctx.reply(`✅ নাম সেভ হয়েছে: <b>${ctx.message.text}</b>\n\nএখন ফাইলগুলো সেন্ড করুন। পাঠানো শেষ হলে "Done" বাটনে ক্লিক করুন।`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Done', 'up_finish'), Markup.button.callback('❌ Cancel', 'up_cancel')]]) });
    }
});

uploadComposer.on('document', async ctx => {
    if (ctx.wizard.state.awaitingFile) {
        ctx.wizard.state.data.file_ids.push(ctx.message.document.file_id);
        const text = `✅ File received! Total: ${ctx.wizard.state.data.file_ids.length}\nSend more or click 'Done'.`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✅ Done', 'up_finish')]]);
        if (ctx.wizard.state.statusMsgId) { try { await ctx.telegram.editMessageText(ctx.chat.id, ctx.wizard.state.statusMsgId, undefined, text, keyboard); } catch (e) { } }
        else { const msg = await ctx.reply(text, keyboard); ctx.wizard.state.statusMsgId = msg.message_id; }
    }
});

uploadComposer.action('up_finish', async ctx => {
    await ctx.answerCbQuery('Saving...'); const data = ctx.wizard.state.data;
    if (data.file_ids.length === 0) { await ctx.reply('❌ No files uploaded.'); return ctx.scene.leave(); }
    try {
        if (data.existingId) {
            if (data.type === 'slide') await Slide.findByIdAndUpdate(data.existingId, { $push: { file_ids: { $each: data.file_ids } } });
            else if (data.type === 'ques') await QuesPaper.findByIdAndUpdate(data.existingId, { $push: { file_ids: { $each: data.file_ids } } });
            await ctx.reply(`✅ ফাইলগুলো সফলভাবে বিদ্যমান চ্যাপ্টারে যুক্ত করা হয়েছে!`);
        } else {
            if (data.type === 'book') await new Book({ subject: data.subject, category: data.category, title: data.title, file_ids: data.file_ids }).save();
            else if (data.type === 'slide') await new Slide({ subject: data.subject, chapterName: data.title, file_ids: data.file_ids }).save();
            else if (data.type === 'ques') await new QuesPaper({ batch: data.batch, subject: data.subject, examName: data.title, file_ids: data.file_ids }).save();
            await ctx.reply(`✅ <b>${data.title}</b> সফলভাবে সেভ করা হয়েছে!`, { parse_mode: 'HTML' });
        }
    } catch (err) { await ctx.reply('❌ Error saving.'); }
    return ctx.scene.leave();
});

const uploadWizard = new Scenes.WizardScene('UPLOAD_WIZARD', async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.scene.leave();
    ctx.wizard.state.data = { file_ids: [] };
    await ctx.reply('🛠 <b>Admin Upload Panel</b>\nফাইলের ধরন নির্বাচন করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📖 Book', 'up_type_book'), Markup.button.callback('🖼 Slide', 'up_type_slide')], [Markup.button.callback('📝 Question', 'up_type_ques'), Markup.button.callback('❌ Cancel', 'up_cancel')]]) });
    return ctx.wizard.next();
}, uploadComposer);

// --- USER CONTRIBUTION COMPOSER ---
const contribComposer = new Composer();
contribComposer.action('c_cancel', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('❌ Contribution বাতিল করা হয়েছে।'); return ctx.scene.leave(); });

contribComposer.action(/c_type_(.+)/, async ctx => {
    ctx.wizard.state.data.type = ctx.match[1]; await ctx.answerCbQuery();
    if (ctx.match[1] === 'ques') {
        const chunked = []; const batches = ['52', '53', '54', '55', '56', '57'].map(b => Markup.button.callback(`Batch ${b}`, `c_batch_${b}`));
        for (let i = 0; i < batches.length; i += 2) chunked.push(batches.slice(i, i + 2)); chunked.push([Markup.button.callback('❌ Cancel', 'c_cancel')]);
        await ctx.editMessageText('ব্যাচ নির্বাচন করুন:', Markup.inlineKeyboard(chunked));
    } else {
        const chunked = getSubjectChunkedButtons('c_sub'); chunked.push([Markup.button.callback('❌ Cancel', 'c_cancel')]);
        await ctx.editMessageText('সাবজেক্ট নির্বাচন করুন:', Markup.inlineKeyboard(chunked));
    }
});

contribComposer.action(/c_batch_(.+)/, async ctx => { ctx.wizard.state.data.batch = ctx.match[1]; await ctx.answerCbQuery(); const chunked = getSubjectChunkedButtons('c_sub'); chunked.push([Markup.button.callback('❌ Cancel', 'c_cancel')]); await ctx.editMessageText('সাবজেক্ট নির্বাচন করুন:', Markup.inlineKeyboard(chunked)); });

contribComposer.action(/c_sub_(.+)/, async ctx => {
    const { type, batch } = ctx.wizard.state.data; const subject = ctx.match[1];
    ctx.wizard.state.data.subject = subject; await ctx.answerCbQuery();

    if (type === 'book') await ctx.editMessageText('এটি Main Book নাকি Guide Book?', Markup.inlineKeyboard([[Markup.button.callback('📗 Main Book', 'c_cat_main'), Markup.button.callback('📙 Guide Book', 'c_cat_guide')], [Markup.button.callback('❌ Cancel', 'c_cancel')]]));
    else if (type === 'slide') {
        const chapters = await Slide.find({ subject }); const btns = chapters.map(c => [Markup.button.callback(`📑 ${c.chapterName}`, `c_ex_${c._id}`)]); btns.push([Markup.button.callback('➕ Add New Chapter', 'c_new')], [Markup.button.callback('❌ Cancel', 'c_cancel')]);
        await ctx.editMessageText(`<b>${subject}</b> এর চ্যাপ্টার সিলেক্ট করুন অথবা নতুন তৈরি করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) });
    } else if (type === 'ques') {
        const exams = await QuesPaper.find({ batch, subject }); const btns = exams.map(e => [Markup.button.callback(`📄 ${e.examName}`, `c_ex_${e._id}`)]); btns.push([Markup.button.callback('➕ Add New Exam', 'c_new')], [Markup.button.callback('❌ Cancel', 'c_cancel')]);
        await ctx.editMessageText(`<b>Batch ${batch} - ${subject}</b> এর এক্সাম সিলেক্ট করুন অথবা নতুন তৈরি করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) });
    }
});

contribComposer.action(/c_cat_(.+)/, async ctx => { ctx.wizard.state.data.category = ctx.match[1]; await ctx.answerCbQuery(); ctx.wizard.state.awaitingText = true; await ctx.editMessageText('বইটির নাম লিখুন:', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'c_cancel')]])); });
contribComposer.action('c_new', async ctx => { await ctx.answerCbQuery(); ctx.wizard.state.awaitingText = true; await ctx.editMessageText('নতুন চ্যাপ্টার বা এক্সামের নাম লিখুন:', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'c_cancel')]])); });

contribComposer.action(/c_ex_(.+)/, async ctx => { ctx.wizard.state.data.existingId = ctx.match[1]; await ctx.answerCbQuery(); await finishContribution(ctx); });
contribComposer.on('text', async ctx => { if (ctx.message.text === '/cancel') return ctx.scene.leave(); if (ctx.wizard.state.awaitingText) { ctx.wizard.state.data.title = ctx.message.text; await finishContribution(ctx); } });

async function finishContribution(ctx) {
    const data = ctx.wizard.state.data;
    try {
        const pendingDoc = await new Pending({ file_id: data.file_id, senderId: ctx.from.id, senderName: ctx.from.first_name, type: data.type, subject: data.subject, category: data.category, batch: data.batch, existingId: data.existingId, title: data.title }).save();
        await ctx.reply(`✅ ধন্যবাদ! আপনার ফাইলটি এডমিনদের কাছে পাঠানো হয়েছে। অ্যাপ্রুভ হলে আপনাকে জানানো হবে!`);

        let targetName = data.title;
        if (data.existingId) {
            if (data.type === 'slide') { const s = await Slide.findById(data.existingId); targetName = `[APPEND] ${s.chapterName}`; }
            if (data.type === 'ques') { const q = await QuesPaper.findById(data.existingId); targetName = `[APPEND] ${q.examName}`; }
        }

        for (const adminId of ADMIN_IDS) {
            try {
                await ctx.telegram.sendDocument(adminId, data.file_id, {
                    caption: `📥 <b>New File Contribution!</b>\n\n👤 <b>From:</b> ${ctx.from.first_name}\n📂 <b>Type:</b> ${data.type.toUpperCase()}\n📚 <b>Subject:</b> ${data.subject}\n🔖 <b>Batch:</b> ${data.batch || 'N/A'}\n🏷 <b>Target:</b> ${targetName}\n\nApprove korle direct save hoye jabe.`,
                    parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve & Save', `app_pend_${pendingDoc._id}`)], [Markup.button.callback('❌ Reject', `rej_pend_${pendingDoc._id}`)]])
                });
            } catch (err) { }
        }
    } catch (err) { await ctx.reply('❌ Error saving contribution.'); }
    return ctx.scene.leave();
}

const contribWizard = new Scenes.WizardScene('CONTRIB_WIZARD', async (ctx) => {
    ctx.wizard.state.data = { file_id: ctx.session.contribFileId };
    await ctx.reply('📤 আপনি একটি ফাইল পাঠিয়েছেন। এটি লাইব্রেরিতে যুক্ত করার জন্য ফাইলের ধরন নির্বাচন করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📖 Book', 'c_type_book'), Markup.button.callback('🖼 Slide', 'c_type_slide')], [Markup.button.callback('📝 Question', 'c_type_ques'), Markup.button.callback('❌ Cancel', 'c_cancel')]]) });
    return ctx.wizard.next();
}, contribComposer);

// --- SEARCH & BROADCAST WIZARDS ---
const searchWizard = new Scenes.WizardScene('SEARCH_WIZARD', async (ctx) => { await ctx.reply('🔍 <b>Search Library</b>\n\nআপনি যা খুঁজতে চান তার নাম টাইপ করে সেন্ড করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Search', 'cancel_search')]]) }); return ctx.wizard.next(); }, async (ctx) => { if (ctx.callbackQuery?.data === 'cancel_search') { await ctx.answerCbQuery(); await ctx.editMessageText('❌ Search cancelled.'); return ctx.scene.leave(); } if (ctx.message?.text) { if (ctx.message.text.startsWith('/')) { await ctx.reply('⚠️ Search cancelled.'); return ctx.scene.leave(); } await performSearch(ctx, ctx.message.text.trim()); return ctx.scene.leave(); } return; });
const broadcastWizard = new Scenes.WizardScene('BROADCAST_WIZARD', async (ctx) => { if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.scene.leave(); await ctx.reply('📢 <b>Broadcast Panel</b>\n\nসব ইউজারকে কী মেসেজ পাঠাতে চান? (অথবা /cancel দিন)', { parse_mode: 'HTML' }); return ctx.wizard.next(); }, async (ctx) => { if (!ctx.message?.text) return; if (ctx.message.text === '/cancel') { await ctx.reply('❌ Broadcast cancelled.'); return ctx.scene.leave(); } const msg = ctx.message.text; const users = await User.find({}); await ctx.reply(`⏳ Sending to ${users.length} users...`); let success = 0, fail = 0; for (let user of users) { try { await ctx.telegram.sendMessage(user.chatId, `🔔 <b>Library Announcement:</b>\n\n${msg}`, { parse_mode: 'HTML' }); success++; } catch (err) { fail++; } } await ctx.reply(`✅ <b>Broadcast Complete!</b>\n🟢 Delivered: ${success}\n🔴 Failed: ${fail}`, { parse_mode: 'HTML' }); return ctx.scene.leave(); });

const stage = new Scenes.Stage([uploadWizard, searchWizard, broadcastWizard, contribWizard]);
bot.use(session()); bot.use(stage.middleware());

// ==========================================
// 5. COMMANDS
// ==========================================
bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' }, { command: 'search', description: 'Search for any file' },
    { command: 'books', description: 'Browse Main & Guide Books' }, { command: 'slides', description: 'Get Chapter-wise Slides' },
    { command: 'ques', description: 'Download Question Papers' }, { command: 'stats', description: 'Admin: Bot Dashboard' },
    { command: 'help', description: 'Get help & info' }
]);

bot.command('upload', (ctx) => ctx.scene.enter('UPLOAD_WIZARD'));
bot.command('search', (ctx) => ctx.scene.enter('SEARCH_WIZARD'));
bot.command('broadcast', (ctx) => ctx.scene.enter('BROADCAST_WIZARD'));

// --- UPDATED: STATS COMMAND WITH AGGREGATION ---
bot.command('stats', async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) {
        return ctx.reply('⛔ এই কমান্ডটি শুধুমাত্র এডমিনদের জন্য।');
    }

    const loadingMsg = await ctx.reply('📊 ডাটাবেস চেক করা হচ্ছে...');

    try {
        const totalUsers = await User.countDocuments();

        // Helper function to sum lengths of file_ids arrays
        const getFileCount = async (Model) => {
            const res = await Model.aggregate([
                { $project: { count: { $size: { $ifNull: ["$file_ids", []] } } } },
                { $group: { _id: null, total: { $sum: "$count" } } }
            ]);
            return res.length > 0 ? res[0].total : 0;
        };

        const totalBooksFiles = await getFileCount(Book);
        const totalSlidesFiles = await getFileCount(Slide);
        const totalQuesFiles = await getFileCount(QuesPaper);

        const overallTotal = totalBooksFiles + totalSlidesFiles + totalQuesFiles;

        const statsText = `
📊 <b>Library Bot - Dashboard</b> 📊

👥 <b>সর্বমোট ইউজার:</b> ${totalUsers} জন

📚 <b>সর্বমোট বই (ফাইল):</b> ${totalBooksFiles} টি
🖼 <b>সর্বমোট স্লাইড (ফাইল):</b> ${totalSlidesFiles} টি
📝 <b>সর্বমোট প্রশ্ন (ফাইল):</b> ${totalQuesFiles} টি
-----------------------------------
📁 <b>সর্বমোট আপলোডকৃত ফাইল:</b> ${overallTotal} টি

<i>আপডেটের সময়: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}</i>
        `;

        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, statsText, { parse_mode: 'HTML' });
    } catch (error) {
        console.error(error);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, '❌ স্ট্যাটিসটিক্স লোড করতে সমস্যা হচ্ছে।');
    }
});

bot.start(async (ctx) => {
    try { await User.findOneAndUpdate({ chatId: ctx.chat.id }, { firstName: ctx.from.first_name }, { upsert: true }); } catch (err) { }
    ctx.reply(`🎓 <b>SBMC Digital Library তে আপনাকে স্বাগতম!</b> 🏛\n\nশের-ই-বাংলা মেডিকেল কলেজের সকল শিক্ষার্থীদের জন্য তৈরি আমাদের এই লাইব্রেরিতে আপনাকে স্বাগতম!\n\nএখানে আপনি Anatomy, Physiology থেকে শুরু করে সকল সাবজেক্টের Books, Slides এবং Question Papers খুঁজে পাবেন।\n\n👇 <b>কীভাবে ব্যবহার করবেন?</b>\nনিচের মেনু থেকে বা কমান্ড ব্যবহার করে ফাইল খুঁজুন, অথবা যেকোনো ফাইলের নাম লিখে সরাসরি <b>Search</b> করুন!\n\n/help - বিস্তারিত জানতে`, { parse_mode: 'HTML' });
});

bot.help((ctx) => {
    ctx.reply(`👋 <b>SBMC Digital Library - হেল্প সেন্টার</b> 🏥\n\nএই বটটি আপনার মেডিকেল পড়াশোনাকে আরও সহজ করার জন্য তৈরি করা হয়েছে।\n\n📚 <b>কমান্ডসমূহ:</b>\n🔍 /search - যেকোনো ফাইল খুঁজতে (বা সরাসরি নাম লিখুন)\n📖 /books - মেইন ও গাইড বই দেখতে\n🖼 /slides - চ্যাপ্টার অনুযায়ী স্লাইড পেতে\n📝 /ques - বিভিন্ন প্রফ বা টার্মের প্রশ্ন পেতে\n\n💡 <b>ইউজার কন্ট্রিবিউশন:</b>\nআপনার কাছে কোনো দরকারি PDF থাকলে সরাসরি এই বটে সেন্ড করুন। বট আপনার কাছে ফাইলের ডিটেইলস জানতে চাইবে। এরপর এডমিন অ্যাপ্রুভ করলেই তা সবার জন্য অ্যাড হয়ে যাবে!\n\n👨‍💻 <b>ডেভেলপারস:</b>\n• Abdullah Al Arafat - @aradotexe\n• Mohammad Naim - @ststrange397`, { parse_mode: 'HTML' });
});

// ==========================================
// 6. ACTION HANDLERS
// ==========================================
bot.action('page_prev', async (ctx) => { if (ctx.session?.searchResults && ctx.session.searchPage > 0) { ctx.session.searchPage--; await renderSearchPage(ctx); await ctx.answerCbQuery(); } });
bot.action('page_next', async (ctx) => { if (ctx.session?.searchResults) { const totalPages = Math.ceil(ctx.session.searchResults.length / ITEMS_PER_PAGE); if (ctx.session.searchPage < totalPages - 1) { ctx.session.searchPage++; await renderSearchPage(ctx); } await ctx.answerCbQuery(); } });

// Books 
bot.command('books', (ctx) => { const chunked = getSubjectChunkedButtons('b_sub'); ctx.reply('📚 <b>Books Section</b>\n\nসাবজেক্ট সিলেক্ট করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) }); });
bot.action(/b_sub_(.+)/, async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText(`📚 <b>${ctx.match[1]} Books</b>\n\nক্যাটাগরি সিলেক্ট করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📗 Main Books', `b_cat_${ctx.match[1]}_main`), Markup.button.callback('📙 Guide Books', `b_cat_${ctx.match[1]}_guide`)], [Markup.button.callback('🔙 Back', 'back_to_books')]]) }); });
bot.action('back_to_books', (ctx) => { ctx.answerCbQuery(); const chunked = getSubjectChunkedButtons('b_sub'); ctx.editMessageText('📚 <b>Books Section</b>\n\nসাবজেক্ট সিলেক্ট করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) }); });
bot.action(/b_cat_(.+?)_(main|guide)/, async (ctx) => {
    const subject = ctx.match[1], category = ctx.match[2]; await ctx.answerCbQuery(); const books = await Book.find({ subject, category });
    if (books.length === 0) return ctx.editMessageText(`No ${category} books found.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `b_sub_${subject}`)]]));
    const buttons = books.map(book => [Markup.button.callback(`📖 ${book.title}`, `dl_book_${book._id}`)]); buttons.push([Markup.button.callback('🔙 Back', `b_sub_${subject}`)]);
    await ctx.editMessageText(`📚 <b>${subject} - ${category.toUpperCase()}</b>\n\nবই সিলেক্ট করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});
bot.action(/dl_book_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Sending...'); const book = await Book.findById(ctx.match[1]); if (!book) return ctx.reply('⚠️ Book not found.');
    await ctx.reply(`Sending: <b>${book.title}</b> 👇`, { parse_mode: 'HTML' }); for (let i = 0; i < book.file_ids.length; i++) await ctx.replyWithDocument(book.file_ids[i]).catch(() => { });
});

// Slides
bot.command('slides', (ctx) => { const chunked = getSubjectChunkedButtons('s_sub'); ctx.reply('🖼 <b>Slides Section</b>\n\nসাবজেক্ট সিলেক্ট করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) }); });
bot.action(/s_sub_(.+)/, async (ctx) => {
    const subject = ctx.match[1]; await ctx.answerCbQuery(); const chapters = await Slide.find({ subject });
    if (chapters.length === 0) return ctx.editMessageText(`No slides found.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'back_to_slides')]]));
    const buttons = chapters.map(chap => [Markup.button.callback(`📑 ${chap.chapterName}`, `dl_slide_${chap._id}`)]); buttons.push([Markup.button.callback('🔙 Back', 'back_to_slides')]);
    await ctx.editMessageText(`🖼 <b>${subject} Slides</b>\n\nচ্যাপ্টার সিলেক্ট করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});
bot.action('back_to_slides', (ctx) => { ctx.answerCbQuery(); const chunked = getSubjectChunkedButtons('s_sub'); ctx.editMessageText('🖼 <b>Slides Section</b>\n\nসাবজেক্ট সিলেক্ট করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) }); });
bot.action(/dl_slide_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Sending...'); const chap = await Slide.findById(ctx.match[1]); if (!chap) return ctx.reply('⚠️ Slide not found.');
    await ctx.reply(`Sending: <b>${chap.chapterName}</b> 👇`, { parse_mode: 'HTML' }); for (let i = 0; i < chap.file_ids.length; i++) await ctx.replyWithDocument(chap.file_ids[i]).catch(() => { });
});

// Ques
bot.command('ques', (ctx) => {
    const chunked = []; const batches = ['52', '53', '54', '55', '56', '57'].map(b => Markup.button.callback(`Batch ${b}`, `q_b_${b}`));
    for (let i = 0; i < batches.length; i += 2) chunked.push(batches.slice(i, i + 2));
    ctx.reply('📝 <b>Question Papers</b>\n\nব্যাচ সিলেক্ট করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) });
});
bot.action(/q_b_(.+)/, async (ctx) => {
    const batch = ctx.match[1]; await ctx.answerCbQuery();
    const chunked = getSubjectChunkedButtons(`q_s_${batch}`); chunked.push([Markup.button.callback('🔙 Back', 'back_to_q')]);
    await ctx.editMessageText(`📝 <b>Batch ${batch}</b>\n\nসাবজেক্ট সিলেক্ট করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) });
});
bot.action('back_to_q', async (ctx) => {
    await ctx.answerCbQuery(); const chunked = []; const batches = ['52', '53', '54', '55', '56', '57'].map(b => Markup.button.callback(`Batch ${b}`, `q_b_${b}`));
    for (let i = 0; i < batches.length; i += 2) chunked.push(batches.slice(i, i + 2));
    await ctx.editMessageText('📝 <b>Question Papers</b>\n\nব্যাচ সিলেক্ট করুন:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(chunked) });
});
bot.action(/q_s_([^_]+)_(.+)/, async (ctx) => {
    const batch = ctx.match[1], subject = ctx.match[2]; await ctx.answerCbQuery(); const exams = await QuesPaper.find({ batch, subject });
    if (exams.length === 0) return ctx.editMessageText(`No question papers found.`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `q_b_${batch}`)]]));
    const buttons = exams.map(exam => [Markup.button.callback(`📄 ${exam.examName}`, `dl_qp_${exam._id}`)]); buttons.push([Markup.button.callback('🔙 Back', `q_b_${batch}`)]);
    await ctx.editMessageText(`📝 <b>Batch ${batch} - ${subject}</b>\n\nএক্সাম সিলেক্ট করুন:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});
bot.action(/dl_qp_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Sending...'); const exam = await QuesPaper.findById(ctx.match[1]); if (!exam) return ctx.reply('⚠️ Not found.');
    await ctx.reply(`Sending: <b>${exam.examName}</b> 👇`, { parse_mode: 'HTML' }); for (const fileId of exam.file_ids) await ctx.replyWithDocument(fileId).catch(() => { });
});

// ==========================================
// 7. USER CONTRIBUTION & ADMIN APPROVAL
// ==========================================
bot.on('document', async (ctx) => {
    if (ADMIN_IDS.includes(ctx.from.id)) return ctx.reply('Admin, file upload korar jonno /upload command use korun.');
    ctx.session = ctx.session || {}; ctx.session.contribFileId = ctx.message.document.file_id;
    await ctx.scene.enter('CONTRIB_WIZARD');
});

bot.action(/^app_pend_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    try {
        const pendingDoc = await Pending.findById(pendingId);
        if (!pendingDoc) return ctx.answerCbQuery('This file has already been handled.', { show_alert: true });
        await ctx.answerCbQuery('Approving and Saving...');

        let targetName = pendingDoc.title;
        if (pendingDoc.existingId) {
            if (pendingDoc.type === 'slide') { const doc = await Slide.findByIdAndUpdate(pendingDoc.existingId, { $push: { file_ids: pendingDoc.file_id } }); targetName = `[APPENDED] ${doc.chapterName}`; }
            else if (pendingDoc.type === 'ques') { const doc = await QuesPaper.findByIdAndUpdate(pendingDoc.existingId, { $push: { file_ids: pendingDoc.file_id } }); targetName = `[APPENDED] ${doc.examName}`; }
        } else {
            if (pendingDoc.type === 'book') await new Book({ subject: pendingDoc.subject, category: pendingDoc.category, title: pendingDoc.title, file_ids: [pendingDoc.file_id] }).save();
            else if (pendingDoc.type === 'slide') await new Slide({ subject: pendingDoc.subject, chapterName: pendingDoc.title, file_ids: [pendingDoc.file_id] }).save();
            else if (pendingDoc.type === 'ques') await new QuesPaper({ batch: pendingDoc.batch, subject: pendingDoc.subject, examName: pendingDoc.title, file_ids: [pendingDoc.file_id] }).save();
        }

        await ctx.editMessageCaption(`✅ <b>Approved & Saved!</b>\n\n👤 <b>From:</b> ${pendingDoc.senderName}\n🏷 <b>Title:</b> ${targetName}`, { parse_mode: 'HTML' });
        try { await ctx.telegram.sendMessage(pendingDoc.senderId, `🎉 <b>Congratulations!</b>\n\nআপনার পাঠানো ফাইলটি এডমিন অ্যাপ্রুভ করেছেন এবং SBMC লাইব্রেরিতে অ্যাড করা হয়েছে। কন্ট্রিবিউট করার জন্য অসংখ্য ধন্যবাদ!`, { parse_mode: 'HTML' }); } catch (e) { }
        await Pending.findByIdAndDelete(pendingId);
    } catch (err) { await ctx.answerCbQuery('Error processing request.', { show_alert: true }); }
});

bot.action(/^rej_pend_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    try {
        const pendingDoc = await Pending.findById(pendingId); if (!pendingDoc) return ctx.answerCbQuery('Already handled.', { show_alert: true });
        await ctx.answerCbQuery('Contribution rejected.');
        await ctx.editMessageCaption(`❌ <b>Rejected by Admin.</b>\n\n👤 <b>From:</b> ${pendingDoc.senderName}\n🏷 <b>Title:</b> ${pendingDoc.title || 'Existing Target'}`, { parse_mode: 'HTML' });
        try { await ctx.telegram.sendMessage(pendingDoc.senderId, `দুঃখিত, আপনার পাঠানো ফাইলটি বর্তমানে লাইব্রেরিতে অ্যাড করা সম্ভব হচ্ছে না। কন্ট্রিবিউট করার জন্য ধন্যবাদ!`, { parse_mode: 'HTML' }); } catch (e) { }
        await Pending.findByIdAndDelete(pendingId);
    } catch (err) { }
});

bot.on('text', async (ctx) => { if (!ctx.message.text.startsWith('/')) await performSearch(ctx, ctx.message.text.trim()); });
bot.catch((err, ctx) => console.error(`[Bot Error] for ${ctx.updateType}:`, err.message));
bot.launch().then(() => console.log('✅ Bot started!')).catch(err => console.error('❌ Telegram error:', err));
process.once('SIGINT', () => bot.stop('SIGINT')); process.once('SIGTERM', () => bot.stop('SIGTERM'));