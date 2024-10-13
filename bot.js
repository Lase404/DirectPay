// Required Modules
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
  { name: 'Access Bank', code: '044', aliases: ['access bank', 'access'] },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank'] },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith bank', 'zenith'] },
  { name: 'First Bank', code: '011', aliases: ['first bank', 'first'] },
  { name: 'UBA', code: '033', aliases: ['uba', 'united bank of africa'] },
  // Add all banks here with possible aliases
];

// Utility Functions

// Verify Bank Account with Paystack
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

// Calculate Payout Based on Asset Type
function calculatePayout(asset, amount) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return (amount * rates[asset]).toFixed(2);
}

// Generate a Unique Reference ID for Transactions
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Main Menu Dynamically Updated Based on Wallet Status
const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ]).resize();

// Admin-only Menu
const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📊 View Transactions', 'admin_view_transactions')],
  [Markup.button.callback('📤 Send Message', 'admin_send_message')],
  [Markup.button.callback('✅ Mark as Paid', 'admin_mark_paid')],
  [Markup.button.callback('📷 Upload Image', 'admin_upload_image')],
]);

// Check if User is Admin
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

// Persistent User State Functions
async function getUserState(userId) {
  try {
    let userState = userStates[userId];
    if (!userState) {
      const doc = await db.collection('userStates').doc(userId).get();
      if (doc.exists) {
        userState = doc.data();
        userStates[userId] = userState;
        console.log(`User state retrieved for user ${userId}`);
      } else {
        // Initialize a new user state if none exists
        userState = { wallets: [], bankDetails: null, hasReceivedDeposit: false };
        userStates[userId] = userState;
        await saveUserState(userId); // Save the new state to Firestore
        console.log(`New user state initialized and saved for user ${userId}`);
      }
    }
    return userState;
  } catch (error) {
    console.error(`Error retrieving user state for user ${userId}:`, error);
    throw new Error('Unable to retrieve user state.');
  }
}

async function saveUserState(userId) {
  try {
    const userState = userStates[userId];
    if (userState) {
      await db.collection('userStates').doc(userId).set(userState, { merge: true });
      console.log(`User state saved for user ${userId}`);
    }
  } catch (error) {
    console.error(`Error saving user state for user ${userId}:`, error);
    throw new Error('Unable to save user state.');
  }
}

// Greet User
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;

  const greeting = walletExists
    ? `👋 Hey, ${ctx.from.first_name}! Welcome back onchain with DirectPay! 🚀\n\nYour seamless journey continues. Manage your wallets and transactions below, and keep enjoying instant cashouts from your crypto assets. Let's keep things rolling!`
    : `👋 Hello, ${ctx.from.first_name}! Welcome to DirectPay!\n\nSay goodbye to delays and complicated P2P transactions. With DirectPay, you can easily send stablecoins and receive cash directly in your bank account within minutes. No KYC, no hassle—just quick and secure transactions.\n\nLet’s get started!\n\n1. **Add Your Bank Account**\n2. **Get Your Dedicated Wallet Address**\n3. **Send Stablecoins and receive cash instantly.**\n\nWe’ve got the best rates and real-time updates to keep you informed every step of the way. Your funds are safe, and you’ll have cash in your account in no time!`;

  // Send greeting message
  await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists));

  // If user is admin, send admin menu
  if (isAdmin(userId)) {
    await ctx.reply('🔑 Welcome to the Admin Panel:', adminMenu);
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    console.error('Error in /start command:', error);
    await ctx.reply('An error occurred. Please try again later.');
  }
});

// Generate Wallet Function
async function generateBaseWallet() {
  try {
    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${BLOCKRADAR_WALLET_ID}/addresses`,
      { name: 'DirectPay_User_Wallet' },
      { headers: { 'x-api-key': BLOCKRADAR_API_KEY } }
    );
    return response.data.data.address;
  } catch (error) {
    throw new Error('Error generating wallet');
  }
}

// Wallet Generation and Viewing

// Generate Wallet
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId); // Save user state

    // Update Menu
    await ctx.replyWithMarkdown(`✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``, getMainMenu(true));

    // Prompt to Link Bank Account
    await ctx.reply('Please link a bank account to receive your payouts.', Markup.keyboard(['🏦 Link Bank Account']).resize());

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId}: ${walletAddress}`);
  } catch (error) {
    console.error('Error generating wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`);
  }
});

// View Wallet
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (!userState || userState.wallets.length === 0) {
    return ctx.reply('You have no wallets. Generate a new wallet below.', getMainMenu(false));
  }

  // Display Wallets
  let walletMessage = '💼 **Your Wallets**:\n\n';
  userState.wallets.forEach((wallet, index) => {
    walletMessage += `#${index + 1} Wallet Address: \`${wallet.address}\`\n`;
    walletMessage += `🔗 Linked Bank: ${wallet.bank ? 'Yes' : 'No'}\n\n`;
  });

  const canCreateNewWallet = userState.wallets[0].bank;

  await ctx.replyWithMarkdown(walletMessage, Markup.inlineKeyboard([
    canCreateNewWallet
      ? [Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')]
      : [Markup.button.callback('🔗 Link Bank to Create New Wallet', 'link_bank')],
  ]));
});

// Create New Wallet
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

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
    await saveUserState(userId); // Save user state

    await ctx.replyWithMarkdown(`✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``, getMainMenu(true));

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 New wallet generated for user ${userId}: ${walletAddress}`);
  } catch (error) {
    console.error('Error generating new wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating new wallet for user ${userId}: ${error.message}`);
  }
});

// Link Bank Account
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // Check if user has wallets
  if (!userState || userState.wallets.length === 0) {
    return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
  }

  // Find the first wallet without a linked bank
  const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

  if (walletIndex === -1) {
    return ctx.reply('All your wallets already have a linked bank account.');
  }

  userState.currentWalletIndex = walletIndex;
  userState.awaitingBankName = true;
  await saveUserState(userId); // Save user state

  await ctx.reply('Please enter your bank name (e.g., Access Bank):');
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
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at https://base.org/bridge.',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at https://docs.base.org for in-depth guides and resources.',
  },
];

bot.hears('📘 Learn About Base', async (ctx) => {
  await sendBaseContent(ctx, 0);
});

// Function to Send Base Content with Pagination
async function sendBaseContent(ctx, index) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  // Send or Edit Message Based on Existing Message ID
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    // Edit existing message
    await ctx.editMessageText(`*${content.title}*\n\n${content.text}`, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(navigationButtons),
    });
  } else {
    // Send new message
    await ctx.replyWithMarkdown(`*${content.title}*\n\n${content.text}`, Markup.inlineKeyboard(navigationButtons));
  }
}

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  await sendBaseContent(ctx, index);
});

// Support Functionality
bot.hears('ℹ️ Support', async (ctx) => {
  await ctx.reply('How can we assist you today?', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.reply('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
});

bot.action('support_not_received', async (ctx) => {
  await ctx.reply('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
});

bot.action('support_contact', async (ctx) => {
  await ctx.reply('You can contact our support team at @your_support_username.');
});

// View Transactions
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('You have no transactions at the moment.');
    }

    let message = '💰 **Your Transactions**:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `🔹 *Reference ID:* ${tx.referenceId}\n`;
      message += `🔹 *Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `🔹 *Status:* ${tx.status || 'Pending'}\n`;
      message += `🔹 *Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    await ctx.reply('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Admin Functions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];
  const userState = await getUserState(userId);

  if (action === 'view_transactions') {
    // Fetch and display transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `🔹 *User ID:* ${tx.userId}\n`;
        message += `🔹 *Username:* ${tx.username || 'N/A'}\n`;
        message += `🔹 *Reference ID:* ${tx.referenceId}\n`;
        message += `🔹 *Amount:* ${tx.amount} ${tx.asset}\n`;
        message += `🔹 *Status:* ${tx.status || 'Pending'}\n`;
        message += `🔹 *Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      await ctx.reply('⚠️ Unable to fetch transactions.');
    }
  } else if (action === 'send_message') {
    // Functionality to send messages to users
    userState.awaitingUserIdForMessage = true;
    await saveUserState(userId); // Save user state
    await ctx.reply('Please enter the User ID you want to message:');
  } else if (action === 'mark_paid') {
    // Display list of pending transactions for admin to select
    try {
      const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();

      if (pendingTransactions.empty) {
        return ctx.reply('No pending transactions found.');
      }

      let message = '✅ **Pending Transactions:**\n\n';
      const buttons = [];

      pendingTransactions.forEach((doc) => {
        const tx = doc.data();
        message += `🔹 *Reference ID:* ${tx.referenceId}\n`;
        message += `🔹 *User ID:* ${tx.userId}\n`;
        message += `🔹 *Amount:* ${tx.amount} ${tx.asset}\n\n`;
        buttons.push([Markup.button.callback(`Mark ${tx.referenceId} as Paid`, `mark_paid_${tx.referenceId}`)]);
      });

      await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(buttons));
    } catch (error) {
      console.error('Error fetching pending transactions:', error);
      await ctx.reply('⚠️ Unable to fetch pending transactions.');
    }
  } else if (action === 'upload_image') {
    // Admin uploads image to user
    userState.awaitingImageUserId = true;
    await saveUserState(userId);
    await ctx.reply('Please enter the User ID you want to upload an image to:');
  }
});

// Handle Admin Actions for Marking Paid and Uploading Images
bot.action(/mark_paid_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const referenceId = ctx.match[1];
  const transactionsSnapshot = await db.collection('transactions').where('referenceId', '==', referenceId).get();

  if (transactionsSnapshot.empty) {
    return ctx.reply('❌ Transaction not found.');
  }

  const transactionDoc = transactionsSnapshot.docs[0];
  const transactionData = transactionDoc.data();

  // Update transaction status to 'Paid'
  await db.collection('transactions').doc(transactionDoc.id).update({ status: 'Paid' });

  // Fetch user information
  const userDoc = await db.collection('userStates').doc(transactionData.userId).get();
  const userData = userDoc.exists ? userDoc.data() : null;

  if (!userData) {
    return ctx.reply('❌ User data not found.');
  }

  // Extract bank details
  const wallet = userData.wallets.find((w) => w.address === transactionData.walletAddress);
  if (!wallet || !wallet.bank) {
    return ctx.reply('❌ Bank details not found for the user.');
  }

  // Detailed Paid Message
  const paidMessage = `Hello ${wallet.bank.accountName},

We’ve converted the *${transactionData.amount} ${transactionData.asset}* you deposited and successfully sent *NGN ${transactionData.cashAmount}* in your linked account.

*Transaction Details*
- **Crypto Amount:** ${transactionData.amount} ${transactionData.asset}
- **Cash Amount:** NGN ${transactionData.cashAmount}
- **Rate:** ${transactionData.rate} NGN/${transactionData.asset}
- **Network:** ${transactionData.network}
- **Receiving Account:** ${wallet.bank.bankName} ****${wallet.bank.accountNumber.slice(-4)}
- **Date:** ${new Date(transactionData.timestamp).toISOString()}
- **Reference:** ${transactionData.referenceId}

[📊 View Transaction](https://t.me/your_bot_username?start=view_transaction_${transactionData.transactionHash})

If you have any questions or need further assistance, please contact us; we’d love to help.

Best Regards,
*DirectPay Team*`;

  // Send the detailed message to the user
  await bot.telegram.sendMessage(transactionData.userId, paidMessage, {
    parse_mode: 'Markdown',
    disable_web_page_preview: false,
  });

  // Notify admin of successful operation
  await ctx.reply(`✅ Transaction ${referenceId} marked as paid and user notified.`);
});

// Handle Admin Upload Image Process
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.awaitingImageUserId) {
    const targetUserId = ctx.message.text.trim();
    userState.uploadImageTargetUserId = targetUserId;
    userState.awaitingImageUserId = false;
    userState.awaitingImage = true;
    await saveUserState(userId); // Save user state

    await ctx.reply('Please send the image you want to upload:');
  } else if (userState.awaitingImage) {
    const targetUserId = userState.uploadImageTargetUserId;
    const photoArray = ctx.message.photo;
    const photo = photoArray[photoArray.length - 1].file_id; // Get highest resolution

    try {
      await bot.telegram.sendPhoto(targetUserId, photo, {
        caption: '📸 Here is the image you requested!',
      });
      await ctx.reply('✅ Image uploaded successfully.');
    } catch (error) {
      console.error('Error uploading image:', error);
      await ctx.reply('⚠️ Failed to upload image. Please ensure the User ID is correct.');
    }

    // Reset admin state
    userState.uploadImageTargetUserId = null;
    userState.awaitingImage = false;
    await saveUserState(userId); // Save user state
  }
});

// Handle Bank Name and Account Number Input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.awaitingBankName) {
    const bankNameInput = ctx.message.text.trim().toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name:');
    }

    userState.bankCode = bank.code;
    userState.bankName = bank.name;
    userState.awaitingBankName = false;
    userState.awaitingAccountNumber = true;
    await saveUserState(userId); // Save user state

    return ctx.reply('Please enter your bank account number:');
  } else if (userState.awaitingAccountNumber) {
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    userState.accountNumber = accountNumber;
    await saveUserState(userId); // Save user state

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);

      const accountName = verificationResult.data.account_name;
      userState.accountName = accountName;
      await saveUserState(userId); // Save user state

      // Ask for Confirmation with Professional Slang
      await ctx.replyWithMarkdown(
        `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${userState.accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this the deets?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Absolutely', 'confirm_bank_yes'),
          Markup.button.callback('❌ Nope, redo', 'confirm_bank_no'),
        ])
      );
    } catch (error) {
      console.error('Error verifying bank account:', error);
      await ctx.reply('❌ Failed to verify bank account. Please try again later.');
      userState.awaitingBankName = true;
      userState.awaitingAccountNumber = false;
      await saveUserState(userId); // Save user state
      return ctx.reply('Please enter your bank name:');
    }

    userState.awaitingAccountNumber = false;
    await saveUserState(userId); // Save user state
  } else if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
    // Handle Admin Messaging
    const recipientId = ctx.message.text.trim();
    userState.messageRecipientId = recipientId;
    userState.awaitingUserIdForMessage = false;
    userState.awaitingMessageContent = true;
    await saveUserState(userId); // Save user state

    await ctx.reply('Please enter the message you want to send:');
  } else {
    // If none of the conditions match, do nothing or send a default message
    return;
  }
});

// Handle Bank Confirmation
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = userState ? userState.currentWalletIndex : undefined;

  if (!userState) {
    console.error(`userState is undefined for userId: ${userId}`);
    return ctx.reply('An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  if (walletIndex === undefined || walletIndex === null) {
    console.error(`walletIndex is undefined or null for userId: ${userId}`);
    return ctx.reply('An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  if (!userState.wallets || !userState.wallets[walletIndex]) {
    console.error(`Wallet not found at index ${walletIndex} for userId: ${userId}`);
    return ctx.reply('An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  // Link Bank to Wallet
  userState.wallets[walletIndex].bank = {
    bankName: userState.bankName,
    bankCode: userState.bankCode,
    accountNumber: userState.accountNumber,
    accountName: userState.accountName,
  };

  // Reset Temp States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.currentWalletIndex = null;
  userState.awaitingBankName = false;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId); // Save user state

  await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

  // Log to Admin with Relevant Details
  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 *User ${userId}* (${ctx.from.username || 'N/A'}) linked a bank account:\n\n*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n*Account Number:* ${userState.wallets[walletIndex].bank.accountNumber}`);
});

bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.reply('⚠️ It seems there was an error. Let\'s try again.');

  // Reset Temp States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.awaitingBankName = true;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId); // Save user state

  return ctx.reply('Please enter your bank name:');
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    console.log('Received webhook:', JSON.stringify(event, null, 2));
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Refined Logging to Admin without Raw JSON
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔔 *Webhook Event Received:* ${event.event}`);

    if (event.event === 'deposit.success') {
      const walletAddress = event.data.address.address;
      const amount = event.data.amount;
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;

      // Find User by Wallet Address from Firestore
      const usersSnapshot = await db.collection('userStates').where('wallets.address', '==', walletAddress).get();

      if (usersSnapshot.empty) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      let userId;
      let userData;
      usersSnapshot.forEach((doc) => {
        userId = doc.id;
        userData = doc.data();
      });

      if (!userId || !userData) {
        console.log(`No user data found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const wallet = userData.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 Deposit Received: ${amount} ${asset}. Please link a bank account to receive your payout securely.`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ *User ${userId}* (${userData.username || 'N/A'}) has received a deposit but hasn't linked a bank account.`);
        return res.status(200).send('OK');
      }

      // Calculate Payout
      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      // Notify User of Successful Deposit with Professional Slang
      const userNotification = `Hello ${wallet.bank.accountName},

🎉 *Deposit Confirmation!*

We’ve received your deposit of *${amount} ${asset}* and are processing it for you. You'll receive *NGN ${payout}* in your linked account shortly.

*Transaction Details:*
- **Crypto Amount:** ${amount} ${asset}
- **Cash Amount:** NGN ${payout}
- **Rate:** ${(payout / amount).toFixed(2)} NGN/${asset}
- **Network:** ${event.data.network || 'N/A'}
- **Receiving Account:** ${wallet.bank.bankName} ****${wallet.bank.accountNumber.slice(-4)}
- **Date:** ${new Date(event.data.timestamp || Date.now()).toLocaleString()}
- **Reference:** ${referenceId}

[📊 View Transaction](https://t.me/your_bot_username?start=view_transaction_${transactionHash})

If you have any questions or need further assistance, please contact us; we’d love to help.

Best Regards,
*DirectPay Team*`;

      await bot.telegram.sendMessage(userId, userNotification, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });

      // Notify Admin with Transaction Details (Refined)
      const adminNotification = `⚡️ *New Deposit Processed:*\n\n*User ID:* ${userId}\n*Username:* ${userData.username || 'N/A'}\n*Reference ID:* ${referenceId}\n*Amount:* ${amount} ${asset}\n*Payout:* NGN ${payout}\n*Transaction Hash:* ${transactionHash}\n*Bank Name:* ${wallet.bank.bankName}\n*Account Number:* ****${wallet.bank.accountNumber.slice(-4)}\n*Date:* ${new Date(event.data.timestamp || Date.now()).toLocaleString()}`;

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminNotification, { parse_mode: 'Markdown' });

      // Store Transaction in Firebase
      await db.collection('transactions').add({
        userId,
        username: userData.username || 'N/A',
        walletAddress,
        amount,
        asset,
        transactionHash,
        referenceId,
        cashAmount: payout,
        rate: (payout / amount).toFixed(2),
        network: event.data.network || 'N/A',
        timestamp: new Date(event.data.timestamp || Date.now()).toISOString(),
        status: 'Pending',
      });

      // Log to Admin that transaction is stored
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 *Transaction stored in Firebase for user ${userId}.*`, { parse_mode: 'Markdown' });

      return res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
    // Refined error message without raw JSON
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
  }
});

// Start Express Server
const port = process.env.PORT || 4000;
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
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
