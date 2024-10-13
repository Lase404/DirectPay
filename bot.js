// Required Modules
const Web3 = require('web3');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Firebase setup
const serviceAccount = require('./directpayngn-firebase-adminsdk-d11t3-17c3c57aa5.json'); // Replace with your actual path
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpayngn.firebaseio.com" // Replace with your actual database URL
});
const db = admin.firestore();

// Config & API Keys
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

// Constants
const MAX_WALLETS = 3; // Max wallets per user

// Manual Bank List
const bankList = [
  { name: 'Access Bank', code: '044' },
  { name: 'GTBank', code: '058' },
  { name: 'Zenith Bank', code: '057' },
  // Add all banks here
];

// Utility Functions

/**
 * Retrieves the user state from Firestore.
 * If the user does not exist, initializes a new state.
 * @param {string} userId - The Telegram user ID.
 * @returns {object} - The user state.
 */
async function getUserState(userId) {
  try {
    const doc = await db.collection('userStates').doc(userId).get();
    if (doc.exists) {
      return doc.data();
    } else {
      const newState = { wallets: [], bankDetails: null, hasReceivedDeposit: false };
      await db.collection('userStates').doc(userId).set(newState);
      return newState;
    }
  } catch (error) {
    console.error('Error fetching user state:', error);
    // Return a default state in case of error
    return { wallets: [], bankDetails: null, hasReceivedDeposit: false };
  }
}

/**
 * Updates the user state in Firestore.
 * @param {string} userId - The Telegram user ID.
 * @param {object} userState - The updated user state.
 */
async function setUserState(userId, userState) {
  try {
    await db.collection('userStates').doc(userId).set(userState);
  } catch (error) {
    console.error('Error setting user state:', error);
  }
}

/**
 * Verify Bank Account with Paystack
 * @param {string} accountNumber
 * @param {string} bankCode
 * @returns {object}
 */
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
 * Generate a Unique Reference ID for Transactions
 * @returns {string}
 */
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Main Menu Dynamically Updated Based on Wallet Status
 * @param {boolean} walletExists
 * @returns {Markup}
 */
const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ]).resize();

/**
 * Admin-only Menu
 * @returns {Markup}
 */
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('View Transactions', 'admin_view_transactions')],
    [Markup.button.callback('Send Message', 'admin_send_message')],
    [Markup.button.callback('Mark Paid', 'admin_mark_paid')],
  ]);

/**
 * Check if User is Admin
 * @param {string} userId
 * @returns {boolean}
 */
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

/**
 * Send Base Content with Pagination
 * @param {Context} ctx
 * @param {number} index
 */
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

  await ctx.replyWithMarkdown(`*${content.title}*\n\n${content.text}`, Markup.inlineKeyboard(navigationButtons));
}

// Greeting Content
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

// Greet User Function
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
    await ctx.reply('🔑 Welcome to the Admin Panel:', getAdminMenu());
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

    // Update User State in Firestore
    await setUserState(userId, userState);

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

  if (userState.wallets.length === 0) {
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
      ? [Markup.button.callback('Create New Wallet', 'create_new_wallet')]
      : [Markup.button.callback('Link Bank to Create New Wallet', 'link_bank')],
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

    // Update User State in Firestore
    await setUserState(userId, userState);

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
  if (userState.wallets.length === 0) {
    return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
  }

  // Find the first wallet without a linked bank
  const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

  if (walletIndex === -1) {
    return ctx.reply('All your wallets already have a linked bank account.');
  }

  // Update userState to indicate the user is awaiting bank details
  userState.currentWalletIndex = walletIndex;
  userState.awaitingBankName = true;
  userState.awaitingAccountNumber = false;

  // Save updated state
  await setUserState(userId, userState);

  await ctx.reply('Please enter your bank name (e.g., Access Bank):');
});

// Learn About Base with Pagination
bot.hears('📘 Learn About Base', async (ctx) => {
  await sendBaseContent(ctx, 0);
});

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
      message += `Reference ID: ${tx.referenceId}\n`;
      message += `Amount: ${tx.amount} ${tx.asset}\n`;
      message += `Status: ${tx.status || 'Pending'}\n`;
      message += `Date: ${new Date(tx.timestamp).toLocaleString()}\n\n`;
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

  if (action === 'view_transactions') {
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `🔹 User ID: ${tx.userId}\n🔹 Reference ID: ${tx.referenceId}\n🔹 Amount: ${tx.amount} ${tx.asset}\n🔹 Status: ${tx.status || 'Pending'}\n🔹 Date: ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      await ctx.reply('⚠️ Unable to fetch transactions.');
    }
  } else if (action === 'send_message') {
    // Initiate send message flow
    const userState = await getUserState(userId);
    userState.awaitingUserIdForMessage = true;
    await setUserState(userId, userState);
    await ctx.reply('Please enter the User ID you want to message (e.g., 123456789):');
  } else if (action === 'mark_paid') {
    // Admin mark-paid function
    try {
      const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
      if (pendingTransactions.empty) {
        return ctx.reply('No pending transactions found.');
      }

      for (const transaction of pendingTransactions.docs) {
        const data = transaction.data();
        await db.collection('transactions').doc(transaction.id).update({ status: 'Paid' });

        // Notify the user
        await bot.telegram.sendMessage(data.userId, `🎉 Your transaction with reference ID ${data.referenceId} has been marked as paid!`);
      }

      await ctx.reply('All pending transactions marked as paid.');
    } catch (error) {
      console.error('Error marking transactions as paid:', error);
      await ctx.reply('⚠️ Error marking transactions as paid. Please try again later.');
    }
  }
});

// Handle Admin Messaging
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
    userState.messageRecipientId = ctx.message.text.trim();
    userState.awaitingUserIdForMessage = false;
    userState.awaitingMessageContent = true;
    await setUserState(userId, userState);
    return ctx.reply('Please enter the message you want to send:');
  } else if (isAdmin(userId) && userState.awaitingMessageContent) {
    const recipientId = userState.messageRecipientId;
    const messageContent = ctx.message.text.trim();

    try {
      await bot.telegram.sendMessage(recipientId, `📩 Message from Admin:\n\n${messageContent}`);
      await ctx.reply('✅ Message sent successfully.');
    } catch (error) {
      console.error('Error sending message to user:', error);
      await ctx.reply('⚠️ Failed to send message to the user.');
    }

    // Reset Admin State
    userState.messageRecipientId = null;
    userState.awaitingMessageContent = false;
    await setUserState(userId, userState);
  } else if (userState.awaitingBankName) {
    // Handle Bank Name Input
    const bankName = ctx.message.text.trim();
    const bank = bankList.find((b) => b.name.toLowerCase() === bankName.toLowerCase());

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name:');
    }

    userState.bankCode = bank.code;
    userState.bankName = bank.name;
    userState.awaitingBankName = false;
    userState.awaitingAccountNumber = true;

    await setUserState(userId, userState);

    return ctx.reply('Please enter your bank account number:');
  } else if (userState.awaitingAccountNumber) {
    // Handle Account Number Input
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    userState.accountNumber = accountNumber;

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);

      const accountName = verificationResult.data.account_name;
      userState.accountName = accountName;

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${userState.accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
          Markup.button.callback('❌ No', 'confirm_bank_no'),
        ])
      );

      userState.awaitingAccountNumber = false;
      await setUserState(userId, userState);
    } catch (error) {
      console.error('Error verifying bank account:', error);
      await ctx.reply('❌ Failed to verify bank account. Please try again later.');
      userState.awaitingBankName = true;
      userState.awaitingAccountNumber = false;
      await setUserState(userId, userState);
      return ctx.reply('Please enter your bank name:');
    }
  } else {
    // If none of the conditions match, do nothing or send a default message
    return;
  }
});

// Handle Bank Confirmation
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = userState.currentWalletIndex;

  if (walletIndex === undefined || walletIndex === null) {
    console.error(`walletIndex is undefined or null for userId: ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  if (!userState.wallets || !userState.wallets[walletIndex]) {
    console.error(`Wallet not found at index ${walletIndex} for userId: ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
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

  // Save updated state
  await setUserState(userId, userState);

  await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

  // Log to Admin
  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);
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

  // Save updated state
  await setUserState(userId, userState);

  return ctx.reply('Please enter your bank name:');
});

// Admin Functions (Updated to ensure access is restricted and flows are handled correctly)
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  if (action === 'view_transactions') {
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `🔹 User ID: ${tx.userId}\n🔹 Reference ID: ${tx.referenceId}\n🔹 Amount: ${tx.amount} ${tx.asset}\n🔹 Status: ${tx.status || 'Pending'}\n🔹 Date: ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      await ctx.reply('⚠️ Unable to fetch transactions.');
    }
  } else if (action === 'send_message') {
    // Initiate send message flow
    const userState = await getUserState(userId);
    userState.awaitingUserIdForMessage = true;
    await setUserState(userId, userState);
    await ctx.reply('Please enter the User ID you want to message (e.g., 123456789):');
  } else if (action === 'mark_paid') {
    // Admin mark-paid function
    try {
      const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
      if (pendingTransactions.empty) {
        return ctx.reply('No pending transactions found.');
      }

      for (const transaction of pendingTransactions.docs) {
        const data = transaction.data();
        await db.collection('transactions').doc(transaction.id).update({ status: 'Paid' });

        // Notify the user
        await bot.telegram.sendMessage(data.userId, `🎉 Your transaction with reference ID ${data.referenceId} has been marked as paid!`);
      }

      await ctx.reply('All pending transactions marked as paid.');
    } catch (error) {
      console.error('Error marking transactions as paid:', error);
      await ctx.reply('⚠️ Error marking transactions as paid. Please try again later.');
    }
  }
});

// Handle Admin Messaging and Bank Linking Flows
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // Admin Messaging Flow
  if (isAdmin(userId)) {
    if (userState.awaitingUserIdForMessage) {
      userState.messageRecipientId = ctx.message.text.trim();
      userState.awaitingUserIdForMessage = false;
      userState.awaitingMessageContent = true;
      await setUserState(userId, userState);
      return ctx.reply('Please enter the message you want to send:');
    } else if (userState.awaitingMessageContent) {
      const recipientId = userState.messageRecipientId;
      const messageContent = ctx.message.text.trim();

      try {
        await bot.telegram.sendMessage(recipientId, `📩 Message from Admin:\n\n${messageContent}`);
        await ctx.reply('✅ Message sent successfully.');
      } catch (error) {
        console.error('Error sending message to user:', error);
        await ctx.reply('⚠️ Failed to send message to the user.');
      }

      // Reset Admin State
      userState.messageRecipientId = null;
      userState.awaitingMessageContent = false;
      await setUserState(userId, userState);
      return;
    }
  }

  // Bank Linking Flow
  if (userState.awaitingBankName) {
    const bankName = ctx.message.text.trim();
    const bank = bankList.find((b) => b.name.toLowerCase() === bankName.toLowerCase());

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name:');
    }

    userState.bankCode = bank.code;
    userState.bankName = bank.name;
    userState.awaitingBankName = false;
    userState.awaitingAccountNumber = true;

    await setUserState(userId, userState);

    return ctx.reply('Please enter your bank account number:');
  } else if (userState.awaitingAccountNumber) {
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    userState.accountNumber = accountNumber;

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);

      const accountName = verificationResult.data.account_name;
      userState.accountName = accountName;

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${userState.accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
          Markup.button.callback('❌ No', 'confirm_bank_no'),
        ])
      );

      userState.awaitingAccountNumber = false;
      await setUserState(userId, userState);
    } catch (error) {
      console.error('Error verifying bank account:', error);
      await ctx.reply('❌ Failed to verify bank account. Please try again later.');
      userState.awaitingBankName = true;
      userState.awaitingAccountNumber = false;
      await setUserState(userId, userState);
      return ctx.reply('Please enter your bank name:');
    }
  } else {
    // If none of the conditions match, do nothing or send a default message
    return;
  }
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    console.log('Received webhook:', JSON.stringify(event, null, 2));
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔔 Webhook Event Received:\n${JSON.stringify(event, null, 2)}`);

    if (event.event === 'deposit.success') {
      const walletAddress = event.data.address.address;
      const amount = event.data.amount;
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;

      // Find User by Wallet Address
      const userId = Object.keys(userStates).find((id) =>
        userStates[id].wallets.some((wallet) => wallet.address === walletAddress)
      );

      // If using Firestore for user states, adjust the retrieval
      const userSnapshot = await db.collection('userStates').where('wallets.address', 'array-contains', walletAddress).get();
      let userIdFromDB = null;

      if (!userSnapshot.empty) {
        userIdFromDB = userSnapshot.docs[0].id;
      }

      if (!userIdFromDB) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const userState = await getUserState(userIdFromDB);
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet.bank) {
        await bot.telegram.sendMessage(userIdFromDB, `💰 Deposit Received: ${amount} ${asset}. Please link a bank account to receive your payout securely.`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userIdFromDB} has received a deposit but hasn't linked a bank account.`);
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      // Notify User of Successful Deposit
      await bot.telegram.sendMessage(userIdFromDB,
        `Hello ${wallet.bank.accountName},\n\nA deposit of ${amount} ${asset} was received on your wallet address: \`${walletAddress}\`.\n\nYour transaction is being processed. You’ll receive NGN ${payout} in your ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} shortly.\n\nWe'll notify you once the process is complete.`,
        Markup.inlineKeyboard([
          Markup.button.callback('📊 View Transaction', `view_transaction_${transactionHash}`)
        ])
      );

      // Notify Admin with Transaction Details
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID,
        `⚡️ User ${userIdFromDB} received ${amount} ${asset}.\n\n📝 Transaction ID: ${transactionHash}\n🔗 Reference ID: ${referenceId}\n\nProcessing NGN ${payout} to ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} now.`
      );

      // Store Transaction in Firebase
      await db.collection('transactions').add({
        userId: userIdFromDB,
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
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 Transaction stored in Firebase for user ${userIdFromDB}.`);

      return res.status(200).send('OK');
    }

    // If event is not 'deposit.success', respond with OK
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
  }
});

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Webhook server running on port ${port}`);
});

// Launch Bot with Drop Pending Updates to Prevent Processing Outdated Queries
bot.launch({
  dropPendingUpdates: true,
})
  .then(() => console.log('DirectPay bot is live!'))
  .catch((err) => console.error('Error launching bot:', err));

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
