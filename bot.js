// DirectPay Telegram Bot 
////////////////////////////
// Founder: Toluwalase Adunbi
////////////////////////////
const Web3 = require('web3');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Firebase setup
const serviceAccount = require('./directpayngn-firebase-adminsdk-d11t3-17c3c57aa5.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpayngn.firebaseio.com"
});
const db = admin.firestore();

// API Keys & other credentials 
const BOT_TOKEN = '7404771579:AAEY0HpgC-3ZmFGq0-bToPkAczGbJ-WND-Q';
const PAYSTACK_API_KEY = 'sk_test_cd857e88d5d474db8238d30d027ea2911cd7fa17';
const BLOCKRADAR_API_KEY = 'grD8lJpMPjvjChMo5SnOl0eZmaabikn2z2S2rXKkAxCM1oWsZDMwFQL9LWgrc';
const BLOCKRADAR_WALLET_ID = '83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d';
const PERSONAL_CHAT_ID = '2009305288';

// Web3 Setup for Base Testnet
const web3 = new Web3('https://sepolia.base.org');

// Bot Initialization
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// State Management
let userStates = {}; // In-memory cache of user states
const MAX_WALLETS = 3; // Max wallets per user

// Manual Bank List with Aliases
const bankList = [
  {
    name: 'Access Bank',
    code: '044',
    aliases: ['access', 'access bank', 'accessbank'],
  },
  {
    name: 'GTBank',
    code: '058',
    aliases: ['gtbank', 'guaranty trust bank', 'gtb', 'gt bank'],
  },
  {
    name: 'Zenith Bank',
    code: '057',
    aliases: ['zenith', 'zenith bank', 'zenithbank'],
  },
  // Add all banks here with their aliases
];

// Utility Functions

/**
 * Verify Bank Account using Paystack API
 * @param {string} accountNumber
 * @param {string} bankCode
 * @returns {Promise<Object>}
 */
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    console.error('Paystack API Error:', error.response ? error.response.data : error.message);
    throw new Error('Failed to verify bank account. Please ensure your details are correct and try again.');
  }
}

/**
 * Calculate Payout Based on Asset Type
 * @param {string} asset
 * @param {number} amount
 * @returns {string}
 */
function calculatePayout(asset, amount) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return (amount * rates[asset]).toFixed(2);
}

/**
 * Get Exchange Rate Based on Asset Type
 * @param {string} asset
 * @returns {number}
 */
function getRate(asset) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return rates[asset];
}

/**
 * Generate a Unique Reference ID for Transactions
 * @returns {string}
 */
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Generate the Main Menu based on wallet existence
 * @param {boolean} walletExists
 * @returns {Markup}
 */
const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ]).resize();

/**
 * Generate the Admin Menu
 * @returns {Markup}
 */
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('View Transactions', 'admin_view_transactions')],
    [Markup.button.callback('Send Message', 'admin_send_message')],
    [Markup.button.callback('Mark Paid', 'admin_mark_paid')],
    [Markup.button.callback('Upload Image to User', 'admin_upload_image')],
  ]);

/**
 * Check if the user is an admin
 * @param {string} userId
 * @returns {boolean}
 */
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

/**
 * Retrieve User State from Firebase or Cache
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getUserState(userId) {
  let userState = userStates[userId];
  if (userState) {
    return userState;
  }
  try {
    const doc = await db.collection('userStates').doc(userId).get();
    if (doc.exists) {
      userState = doc.data();
      userStates[userId] = userState;
      return userState;
    } else {
      userState = { wallets: [], bankDetails: null, hasReceivedDeposit: false };
      userStates[userId] = userState;
      return userState;
    }
  } catch (error) {
    console.error(`Error fetching user state for ${userId}:`, error);
    throw new Error('Internal server error. Please try again later.');
  }
}

/**
 * Save User State to Firebase and Cache
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function saveUserState(userId) {
  const userState = userStates[userId];
  if (userState) {
    try {
      await db.collection('userStates').doc(userId).set(userState);
    } catch (error) {
      console.error(`Error saving user state for ${userId}:`, error);
      throw new Error('Internal server error. Please try again later.');
    }
  }
}

/**
 * Greet the User upon /start
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;

  const greeting = walletExists
    ? `👋 Hey, ${ctx.from.first_name}! Welcome back onchain with DirectPay! 🚀\n\nYour seamless journey continues. Manage your wallets and transactions below, and keep enjoying instant cashouts from your crypto assets. Let's keep things rolling!`
    : `👋 Hello, ${ctx.from.first_name}! Welcome to DirectPay!\n\nSay goodbye to delays and complicated P2P transactions. With DirectPay, you can easily send stablecoins and receive cash directly in your bank account within minutes. No KYC, no hassle—just quick and secure transactions.\n\nLet’s get started!\n\n1. **Add Your Bank Account**\n2. **Get Your Dedicated Wallet Address**\n3. **Send Stablecoins and receive cash instantly.**\n\nWe’ve got the best rates and real-time updates to keep you informed every step of the way. Your funds are safe, and you’ll have cash in your account in no time!`;

  // Send greeting message
  try {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists));
  } catch (error) {
    console.error('Error sending greeting message:', error);
    await ctx.reply('👋 Hello! Welcome to DirectPay. Let\'s get started!');
  }

  // If user is admin, send admin menu
  if (isAdmin(userId)) {
    try {
      await ctx.reply('🔑 Welcome to the Admin Panel:', getAdminMenu());
    } catch (error) {
      console.error('Error sending admin menu:', error);
    }
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    console.error('Error in /start command:', error);
    await ctx.reply('⚠️ An error occurred while processing your request. Please try again later.');
  }
});

/**
 * Generate a Base Wallet using BlockRadar API
 * @returns {Promise<string>}
 */
async function generateBaseWallet() {
  try {
    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${BLOCKRADAR_WALLET_ID}/addresses`,
      { name: 'DirectPay_User_Wallet' },
      { headers: { 'x-api-key': BLOCKRADAR_API_KEY } }
    );
    return response.data.data.address;
  } catch (error) {
    console.error('BlockRadar API Error:', error.response ? error.response.data : error.message);
    throw new Error('Error generating wallet. Please try again later.');
  }
}

// Wallet Generation Handler
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving your data. Please try again later.');
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId);

    // Save wallet address mapping
    await db.collection('walletAddresses').doc(walletAddress).set({ userId });

    // Update Menu
    await ctx.replyWithMarkdown(
      `✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``,
      getMainMenu(true)
    );

    // Prompt to Link Bank Account
    await ctx.reply('📌 Please link a bank account to receive your payouts.', Markup.keyboard(['🏦 Link Bank Account']).resize());

    // Delete the generating message
    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation to Admin
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `💼 Wallet generated for user ${userId} (@${ctx.from.username || 'N/A'}): ${walletAddress}`
    );
  } catch (error) {
    console.error('Error generating wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error generating wallet for user ${userId}: ${error.message}`
    );
  }
});

// View Wallet Handler
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving your wallets. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.reply('📭 You have no wallets. Generate a new wallet below.', getMainMenu(false));
  }

  // Display Wallets
  let walletMessage = '💼 **Your Wallets**:\n\n';
  userState.wallets.forEach((wallet, index) => {
    walletMessage += `#${index + 1} Wallet Address:\n\`${wallet.address}\`\n`;
    walletMessage += `🔗 Linked Bank: ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
  });

  // Determine if user can create a new wallet
  const canCreateNewWallet = userState.wallets[0].bank;

  try {
    await ctx.replyWithMarkdown(
      walletMessage,
      Markup.inlineKeyboard([
        canCreateNewWallet
          ? [Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')]
          : [Markup.button.callback('🔗 Link Bank to Create Wallet', 'link_bank')],
      ])
    );
  } catch (error) {
    console.error('Error sending wallet information:', error);
    await ctx.reply('⚠️ An error occurred while displaying your wallets. Please try again later.');
  }
});

// Create New Wallet Handler
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving your data. Please try again later.');
  }

  if (!userState.wallets[0].bank) {
    return ctx.reply('⚠️ You must link a bank to your first wallet before creating a new one.');
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating a new wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId);

    // Save wallet address mapping
    await db.collection('walletAddresses').doc(walletAddress).set({ userId });

    await ctx.replyWithMarkdown(
      `✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``,
      getMainMenu(true)
    );

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation to Admin
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `💼 New wallet generated for user ${userId} (@${ctx.from.username || 'N/A'}): ${walletAddress}`
    );
  } catch (error) {
    console.error('Error generating new wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error generating new wallet for user ${userId}: ${error.message}`
    );
  }
});

// Link Bank Account Handler
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving your data. Please try again later.');
  }

  // Check if user has wallets
  if (userState.wallets.length === 0) {
    return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
  }

  // Find the first wallet without a linked bank
  const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

  if (walletIndex === -1) {
    return ctx.reply('✅ All your wallets already have a linked bank account.');
  }

  // Update user state to await bank name
  userState.currentWalletIndex = walletIndex;
  userState.awaitingBankName = true;
  await saveUserState(userId);

  await ctx.reply('📌 Please enter your bank name (e.g., Access Bank):');
});

// Handle Bank Name and Account Number Input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving your data. Please try again later.');
  }

  // Handle Bank Name Input
  if (userState.awaitingBankName) {
    const bankNameInput = ctx.message.text.trim().toLowerCase();
    const bank = bankList.find((b) =>
      b.aliases.map((alias) => alias.toLowerCase()).includes(bankNameInput)
    );

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name (e.g., GTBank, Zenith Bank):');
    }

    userState.bankCode = bank.code;
    userState.bankName = bank.name;
    userState.awaitingBankName = false;
    userState.awaitingAccountNumber = true;
    await saveUserState(userId);

    return ctx.reply('🔐 Please enter your 10-digit bank account number:');
  }

  // Handle Bank Account Number Input
  if (userState.awaitingAccountNumber) {
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    userState.accountNumber = accountNumber;
    userState.awaitingAccountNumber = false;
    await saveUserState(userId);

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);

      if (verificationResult.status !== 'success') {
        throw new Error('Bank account verification failed.');
      }

      const accountName = verificationResult.data.account_name;
      userState.accountName = accountName;
      await saveUserState(userId);

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 **Bank Account Verification**\n\n` +
        `*Bank Name:* ${userState.bankName}\n` +
        `*Account Number:* ${userState.accountNumber}\n` +
        `*Account Holder:* ${accountName}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
          Markup.button.callback('❌ No', 'confirm_bank_no'),
        ])
      );
    } catch (error) {
      console.error('Error verifying bank account:', error);
      await ctx.reply('❌ Failed to verify bank account. Please ensure your details are correct and try again.');
      userState.awaitingBankName = true;
      userState.awaitingAccountNumber = false;
      await saveUserState(userId);
      return ctx.reply('📌 Please enter your bank name (e.g., Access Bank):');
    }

    return;
  }

  // Handle Admin Message Sending
  if (isAdmin(userId) && userState.awaitingMessageContent) {
    const recipientId = userState.messageRecipientId;
    const messageContent = ctx.message.text.trim();

    if (!recipientId || !messageContent) {
      return ctx.reply('❌ Missing User ID or message content. Please try again.');
    }

    try {
      await bot.telegram.sendMessage(recipientId, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
      await ctx.reply('✅ Message sent successfully.');
    } catch (error) {
      console.error('Error sending message to user:', error);
      await ctx.reply('⚠️ Failed to send message to the user. Please ensure the User ID is correct.');
    }

    // Reset Admin State
    userState.messageRecipientId = null;
    userState.awaitingMessageContent = false;
    await saveUserState(userId);
    return;
  }

  // Handle Admin Image Upload Recipient ID
  if (isAdmin(userId) && userState.awaitingImageRecipientId) {
    const recipientId = ctx.message.text.trim();

    if (!/^\d+$/.test(recipientId)) {
      return ctx.reply('❌ Invalid User ID. Please enter a valid numeric User ID:');
    }

    userState.imageRecipientId = recipientId;
    userState.awaitingImageRecipientId = false;
    userState.awaitingImageUpload = true;
    await saveUserState(userId);

    return ctx.reply('📸 Please upload the image you want to send:');
  }

  // Handle Admin Image Upload
  if (isAdmin(userId) && userState.awaitingImageUpload) {
    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1].file_id; // Get highest resolution
      const recipientId = userState.imageRecipientId;

      try {
        await bot.telegram.sendPhoto(recipientId, photo, { caption: '📸 Image sent by Admin.' });
        await ctx.reply('✅ Image sent successfully.');
      } catch (error) {
        console.error('Error sending image to user:', error);
        await ctx.reply('⚠️ Failed to send image to the user. Please ensure the User ID is correct.');
      }

      // Reset Admin State
      userState.imageRecipientId = null;
      userState.awaitingImageUpload = false;
      await saveUserState(userId);
      return;
    } else {
      return ctx.reply('❌ No image detected. Please upload a valid image file.');
    }
  }
});

// Handle Bank Confirmation (Yes)
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred. Please try linking your bank account again.');
  }

  const walletIndex = userState.currentWalletIndex;

  if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
    console.error(`Invalid wallet index for user ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please try linking your bank account again.');
  }

  // Link Bank to Wallet
  userState.wallets[walletIndex].bank = {
    bankName: userState.bankName,
    bankCode: userState.bankCode,
    accountNumber: userState.accountNumber,
    accountName: userState.accountName,
  };

  // Reset Temporary States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.currentWalletIndex = null;
  userState.awaitingBankName = false;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId);

  try {
    await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));
  } catch (error) {
    console.error('Error sending bank linked confirmation:', error);
    await ctx.reply('✅ Your bank account has been linked successfully!');
  }

  // Log to Admin
  try {
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🔗 *Bank Account Linked*\n\n` +
      `*User ID:* ${userId}\n` +
      `*Username:* @${ctx.from.username || 'N/A'}\n` +
      `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
      `*Account Number:* ${userState.wallets[walletIndex].bank.accountNumber}\n` +
      `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}`
    );
  } catch (error) {
    console.error('Error logging bank link to admin:', error);
  }
});

// Handle Bank Confirmation (No)
bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred. Please try linking your bank account again.');
  }

  await ctx.reply('⚠️ Let\'s try again.');

  // Reset Temporary States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.awaitingBankName = true;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId);

  return ctx.reply('📌 Please enter your bank name (e.g., Access Bank):');
});

// Learn About Base with Pagination
const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Base Bridge](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Docs](https://docs.base.org) for in-depth guides and resources.',
  },
];

/**
 * Send Base Content with Pagination
 * @param {Context} ctx
 * @param {number} index
 * @param {boolean} isNewMessage
 */
async function sendBaseContent(ctx, index, isNewMessage = false) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  if (isNewMessage) {
    try {
      await ctx.replyWithMarkdown(
        `*${content.title}*\n\n${content.text}`,
        Markup.inlineKeyboard(navigationButtons)
      );
    } catch (error) {
      console.error('Error sending Base content:', error);
      await ctx.reply('📘 Learn About Base', Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back', `base_page_${index - 1}`)],
        [Markup.button.callback('Next ➡️', `base_page_${index + 1}`)],
      ]));
    }
  } else {
    try {
      await ctx.editMessageText(
        `*${content.title}*\n\n${content.text}`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(navigationButtons).reply_markup,
        }
      );
    } catch (error) {
      console.error('Error editing Base content message:', error);
      await ctx.reply('📘 Learn About Base', Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back', `base_page_${index - 1}`)],
        [Markup.button.callback('Next ➡️', `base_page_${index + 1}`)],
      ]));
    }
  }
}

// Learn About Base Handler
bot.hears('📘 Learn About Base', async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.reply('⚠️ Invalid page number.');
  }
  await sendBaseContent(ctx, index);
});

// Support Functionality
bot.hears('ℹ️ Support', async (ctx) => {
  try {
    await ctx.reply('How can we assist you today?', Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]));
  } catch (error) {
    console.error('Error sending support options:', error);
    await ctx.reply('⚠️ An error occurred while displaying support options. Please try again later.');
  }
});

// Support Actions Handlers
bot.action('support_how_it_works', async (ctx) => {
  await ctx.answerCbQuery(); // Acknowledge the callback
  try {
    await ctx.editMessageText('💡 *How It Works*\n\nDirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments with ease.');
  } catch (error) {
    console.error('Error editing support message:', error);
    await ctx.reply('💡 *How It Works*\n\nDirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments with ease.', { parse_mode: 'Markdown' });
  }
});

bot.action('support_not_received', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText('⚠️ *Transaction Not Received*\n\nIf you haven’t received your transaction, please ensure that you have linked your bank account correctly. If the issue persists, contact our support team for assistance.');
  } catch (error) {
    console.error('Error editing support message:', error);
    await ctx.reply('⚠️ *Transaction Not Received*\n\nIf you haven’t received your transaction, please ensure that you have linked your bank account correctly. If the issue persists, contact our support team for assistance.', { parse_mode: 'Markdown' });
  }
});

bot.action('support_contact', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText('📞 *Contact Support*\n\nYou can reach our support team at [@your_support_username](https://t.me/your_support_username). We’re here to help!');
  } catch (error) {
    console.error('Error editing support message:', error);
    await ctx.reply('📞 *Contact Support*\n\nYou can reach our support team at [@your_support_username](https://t.me/your_support_username). We’re here to help!', { parse_mode: 'Markdown' });
  }
});

// View Transactions Handler
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving your transactions. Please try again later.');
  }

  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('📭 You have no transactions at the moment.');
    }

    let message = '💰 **Your Transactions**:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* ${tx.referenceId}\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    await ctx.reply('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Admin Functions Handler
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while processing your request. Please try again later.');
  }

  if (action === 'view_transactions') {
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('📭 No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `*Transaction ID:* ${doc.id}\n`;
        message += `*User ID:* ${tx.userId}\n`;
        message += `*Reference ID:* ${tx.referenceId}\n`;
        message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
        message += `*Status:* ${tx.status || 'Pending'}\n`;
        message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching all transactions:', error);
      await ctx.reply('⚠️ Unable to fetch transactions. Please try again later.');
    }
  } else if (action === 'send_message') {
    // Prompt admin to enter User ID for messaging
    userState.awaitingMessageRecipientId = true;
    await saveUserState(userId);
    await ctx.reply('📬 Please enter the User ID you want to send a message to:');
  } else if (action === 'mark_paid') {
    // Display list of pending transactions with buttons to mark as paid
    try {
      const pendingTransactionsSnapshot = await db.collection('transactions').where('status', '==', 'Pending').get();
      if (pendingTransactionsSnapshot.empty) {
        return ctx.reply('📭 No pending transactions found.');
      }

      let message = '📝 **Pending Transactions**:\n\n';
      const buttons = [];

      pendingTransactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `*Transaction ID:* ${doc.id}\n`;
        message += `*User ID:* ${tx.userId}\n`;
        message += `*Reference ID:* ${tx.referenceId}\n`;
        message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
        message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
        buttons.push([Markup.button.callback(`Mark Paid: ${tx.referenceId}`, `mark_paid_${doc.id}`)]);
      });

      await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(buttons));
    } catch (error) {
      console.error('Error fetching pending transactions:', error);
      await ctx.reply('⚠️ Unable to fetch pending transactions. Please try again later.');
    }
  } else if (action === 'upload_image') {
    // Prompt admin to enter User ID for image upload
    userState.awaitingImageRecipientId = true;
    await saveUserState(userId);
    await ctx.reply('📸 Please enter the User ID you want to send an image to:');
  }
});

// Handle Mark Paid Action
bot.action(/mark_paid_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const transactionId = ctx.match[1];
  let transactionDoc;

  try {
    transactionDoc = await db.collection('transactions').doc(transactionId).get();
    if (!transactionDoc.exists) {
      return ctx.reply('⚠️ Transaction not found.');
    }
  } catch (error) {
    console.error('Error fetching transaction:', error);
    return ctx.reply('⚠️ An error occurred while fetching the transaction. Please try again later.');
  }

  const transactionData = transactionDoc.data();

  // Update transaction status to 'Paid'
  try {
    await db.collection('transactions').doc(transactionId).update({ status: 'Paid' });
  } catch (error) {
    console.error('Error updating transaction status:', error);
    return ctx.reply('⚠️ An error occurred while updating the transaction. Please try again later.');
  }

  // Retrieve user state
  let userState;
  try {
    userState = await getUserState(transactionData.userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while retrieving user data. Please try again later.');
  }

  // Find the associated wallet
  const wallet = userState.wallets.find((w) => w.address === transactionData.walletAddress);
  if (!wallet || !wallet.bank) {
    console.error(`Wallet or bank details not found for user ${transactionData.userId}`);
    return ctx.reply('⚠️ User wallet or bank details not found.');
  }

  // Compose detailed message to send to the user
  const payoutAmount = calculatePayout(transactionData.asset, transactionData.amount);
  const rate = getRate(transactionData.asset);
  const date = new Date().toISOString();
  const message = `Hello ${wallet.bank.accountName},\n\n` +
    `We’ve converted the *${transactionData.amount} ${transactionData.asset}* you deposited and successfully sent *NGN ${payoutAmount}* to your linked account.\n\n` +
    `*Transaction Details*\n` +
    `• *Crypto Amount:* ${transactionData.amount} ${transactionData.asset}\n` +
    `• *Cash Amount:* NGN ${payoutAmount}\n` +
    `• *Rate:* ${rate} NGN/${transactionData.asset}\n` +
    `• *Network:* ${transactionData.network || 'Base Network'}\n` +
    `• *Receiving Account:* ${wallet.bank.bankName.toUpperCase()} ******${wallet.bank.accountNumber.slice(-4)}\n` +
    `• *Date:* ${date}\n` +
    `• *Reference:* ${transactionData.referenceId}\n\n` +
    `🔗 [View Transaction](https://yourdomain.com/transaction/${transactionId})\n\n` +
    `If you have any questions or need further assistance, please contact us; we’d love to help.`;

  // Send detailed message to the user
  try {
    await bot.telegram.sendMessage(transactionData.userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error sending transaction completion message to user:', error);
    await ctx.reply('⚠️ Failed to notify the user about the transaction. Please check the User ID and try again.');
  }

  // Notify admin about the action
  try {
    await ctx.reply('✅ Transaction marked as paid and user notified successfully.');
  } catch (error) {
    console.error('Error notifying admin:', error);
    await ctx.reply('✅ Transaction marked as paid, but failed to notify the user.');
  }
});

// Handle Admin Image Upload Recipient ID
bot.hears('📸 Upload Image to User', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while processing your request. Please try again later.');
  }

  userState.awaitingImageRecipientId = true;
  await saveUserState(userId);

  await ctx.reply('📸 Please enter the User ID you want to send an image to:');
});

// Handle Admin Image Upload
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  if (!isAdmin(userId)) {
    return; // Ignore photos from non-admin users
  }

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while processing your request. Please try again later.');
  }

  if (userState.awaitingImageUpload) {
    if (!ctx.message.photo) {
      return ctx.reply('❌ No image detected. Please upload a valid image file.');
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1].file_id; // Get highest resolution
    const recipientId = userState.imageRecipientId;

    try {
      await bot.telegram.sendPhoto(recipientId, photo, { caption: '📸 Image sent by Admin.' });
      await ctx.reply('✅ Image sent successfully.');
    } catch (error) {
      console.error('Error sending image to user:', error);
      await ctx.reply('⚠️ Failed to send image to the user. Please ensure the User ID is correct.');
    }

    // Reset Admin State
    userState.imageRecipientId = null;
    userState.awaitingImageUpload = false;
    await saveUserState(userId);
  }
});

// Handle Admin Image Upload Recipient ID (from send_image flow)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  if (!isAdmin(userId)) {
    return; // Ignore texts from non-admin users
  }

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error retrieving user state:', error);
    return ctx.reply('⚠️ An error occurred while processing your request. Please try again later.');
  }

  // Handle Admin Image Upload Recipient ID
  if (userState.awaitingImageRecipientId) {
    const recipientId = ctx.message.text.trim();

    if (!/^\d+$/.test(recipientId)) {
      return ctx.reply('❌ Invalid User ID. Please enter a valid numeric User ID:');
    }

    userState.imageRecipientId = recipientId;
    userState.awaitingImageRecipientId = false;
    userState.awaitingImageUpload = true;
    await saveUserState(userId);

    return ctx.reply('📸 Please upload the image you want to send:');
  }
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;

    // Log the received webhook
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Handle only deposit success events
    if (event.event === 'deposit.success' || event.event === 'deposit.swept.success') {
      const walletAddress = event.data.address.address;
      const amount = parseFloat(event.data.amount);
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;

      // Find User by Wallet Address
      const walletDoc = await db.collection('walletAddresses').doc(walletAddress).get();

      if (!walletDoc.exists) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const userId = walletDoc.data().userId;
      let userState;

      try {
        userState = await getUserState(userId);
      } catch (error) {
        console.error('Error retrieving user state:', error);
        return res.status(200).send('OK');
      }

      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      if (!wallet) {
        console.log(`Wallet ${walletAddress} not found for user ${userId}`);
        return res.status(200).send('OK');
      }

      // Check if Wallet has Linked Bank
      if (!wallet.bank) {
        try {
          await bot.telegram.sendMessage(
            userId,
            `💰 *Deposit Received:*\n\nYou have received a deposit of *${amount} ${asset}*. Please link your bank account to receive your payout securely.`,
            { parse_mode: 'Markdown' }
          );
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `⚠️ User ${userId} (@${userState.username || 'N/A'}) has received a deposit but hasn't linked a bank account.`
          );
        } catch (error) {
          console.error('Error notifying user or admin:', error);
        }
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      // Notify User of Successful Deposit
      const userMessage = `Hello ${wallet.bank.accountName},\n\n` +
        `We received your deposit of *${amount} ${asset}* to your wallet address: \`${walletAddress}\`.\n\n` +
        `Your transaction is being processed. You’ll receive *NGN ${payout}* in your ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} shortly.\n\n` +
        `We'll notify you once the process is complete.`;

      try {
        await bot.telegram.sendMessage(userId, userMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Error sending deposit notification to user:', error);
      }

      // Refined notification to Admin
      const adminMessage = `🔔 *Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Username:* @${userState.username || 'N/A'}\n` +
        `*Wallet Address:* ${walletAddress}\n` +
        `*Amount:* ${amount} ${asset}\n` +
        `*Transaction Hash:* ${transactionHash}\n` +
        `*Bank Name:* ${wallet.bank.bankName}\n` +
        `*Account Number:* ${wallet.bank.accountNumber}\n` +
        `*Account Name:* ${wallet.bank.accountName}\n\n` +
        `*Payout Amount:* NGN ${payout}\n` +
        `*Reference ID:* ${referenceId}\n\n` +
        `Processing NGN ${payout} to the linked bank account.`;

      try {
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Error sending deposit notification to admin:', error);
      }

      // Store Transaction in Firebase
      try {
        await db.collection('transactions').add({
          userId,
          walletAddress,
          amount,
          asset,
          transactionHash,
          referenceId,
          bankDetails: wallet.bank,
          timestamp: new Date().toISOString(),
          status: 'Pending',
        });

        // Log to Admin
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 Transaction stored in Firebase for user ${userId}.`);
      } catch (error) {
        console.error('Error storing transaction in Firebase:', error);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error storing transaction for user ${userId}: ${error.message}`);
      }

      return res.status(200).send('OK');
    } else {
      // For other events, simply acknowledge
      return res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
    try {
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
    } catch (sendError) {
      console.error('Error notifying admin about webhook failure:', sendError);
    }
  }
});

// Start Express Server
const port = 4000; // You can change the port if needed
app.listen(port, () => {
  console.log(`Webhook server running on port ${port}`);
});

// Launch Bot
bot.launch({
  dropPendingUpdates: true, // Optional: Drop pending updates on restart
})
  .then(() => console.log('DirectPay bot is live!'))
  .catch((err) => console.error('Error launching bot:', err));

// Graceful Shutdown
process.once('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully.');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down gracefully.');
  bot.stop('SIGTERM');
});
