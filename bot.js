// Required Modules
const { Telegraf, Markup, session } = require('telegraf');
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
const PERSONAL_CHAT_ID = '2009305288';
const MAX_WALLETS = 5; // maximum number of wallets per user
// Initialize Telegraf Bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize Express App for Webhook
const app = express();
app.use(express.json());

// Supported Chains Configuration with Specific BlockRadar API IDs and Keys
const supportedChains = [
  {
    name: 'Base',
    id: '83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d',
    key: 'grD8lJpMPjvjChMo5SnOl0eZmaabikn2z2S2rXKkAxCM1oWsZDMwFQL9LWgrc',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1',
    walletName: 'DirectPay_Base_Wallet',
    supportedAssets: ['USDT', 'USDC', 'ETH'],
  },
  {
    name: 'Polygon',
    id: 'f7d5b102-e94a-493a-8e0c-8da96fe70655',
    key: 'iXV8e72v9QLKcKfI4Nw8SkqKtEoyzAQFCFinIZKwj7pKUtFxaRMjlLCt5p3DZND',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1', // Update if different
    walletName: 'DirectPay_Polygon_Wallet',
    supportedAssets: ['USDT', 'USDC', 'ETH'],
  },
  {
    name: 'BNB Smart Chain',
    id: '2cab1ef2-8589-4ff9-9017-76cc4d067719',
    key: '6HGRj2cdzULDUbrjGHZftwNyHswUZojxA40mQp77e5vDzWqJ6v13w2iE4DBHzu',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1', // Update if different
    walletName: 'DirectPay_BNB_Wallet',
    supportedAssets: ['USDT', 'USDC'],
  },
];

// Manual Bank List with Aliases
const bankList = [
  { 
    name: '9mobile 9Payment Service Bank', 
    code: '120001',
    aliases: ['9mobile payment service bank', '9psb', '9mobile'],
  },
  { 
    name: 'Abbey Mortgage Bank', 
    code: '801',
    aliases: ['abbey mortgage', 'abbey'],
  },
  // ... (Include all other banks as per your original list)
  { 
    name: 'Zenith Bank', 
    code: '057',
    aliases: ['zenith bank', 'zenith'],
  }
];

// Initialize Session Middleware for State Management
bot.use(session());

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
      const newState = { wallets: [], awaiting: null };
      await db.collection('userStates').doc(userId).set(newState);
      return newState;
    }
  } catch (error) {
    console.error('Error fetching user state:', error);
    // Return a default state in case of error
    return { wallets: [], awaiting: null };
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
 * Adds a wallet address to the 'wallets' collection for mapping.
 * @param {string} walletAddress 
 * @param {string} userId 
 * @param {string} chainName 
 */
async function addWalletMapping(walletAddress, userId, chainName) {
  try {
    await db.collection('wallets').doc(walletAddress).set({ userId, chainName });
  } catch (error) {
    console.error('Error adding wallet mapping:', error);
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
  const rates = { USDT: 1641.81, USDC: 1641.81, ETH: 3968483.33 };
  if (!rates[asset]) {
    return '0.00';
  }
  return (amount * rates[asset]).toFixed(2);
}

/**
 * Generate a Unique Reference ID for Transactions
 * @returns {string}
 */
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
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('View Transactions', 'admin_view_transactions')],
    [Markup.button.callback('Send Message', 'admin_send_message')],
    [Markup.button.callback('Send Image', 'admin_send_image')],
    [Markup.button.callback('Mark Paid', 'admin_mark_paid')],
  ]);

/**
 * Check if User is Admin
 * @param {string} userId
 * @returns {boolean}
 */
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

/**
 * Send Chain Information (Base Only)
 * @param {Context} ctx
 */
async function sendChainInfo(ctx) {
  const message = `
*📘 Learn About Base*

_Base_ is a cutting-edge Ethereum Layer 2 network designed to enhance scalability, reduce transaction fees, and improve overall user experience. Here's why you should consider using Base for your crypto transactions:

🔹 **High Performance:** Base offers lightning-fast transaction speeds, ensuring your transactions are processed almost instantly.

🔹 **Low Fees:** Enjoy minimal transaction fees compared to Ethereum's mainnet, making it cost-effective for frequent transactions.

🔹 **Security:** Built with robust security protocols, Base ensures your assets are safe and protected against potential threats.

🔹 **Developer-Friendly:** With comprehensive developer tools and support, building and deploying decentralized applications (dApps) on Base is seamless.

🔹 **Supported Assets:**
  - *USDT*
  - *USDC*
  - *ETH*

🔹 **Seamless Integration:** Easily generate wallets, link your bank accounts, and manage your crypto assets all within the DirectPay platform.

Start leveraging the power of Base today to experience a more efficient and user-centric blockchain environment!
  `;
  try {
    await ctx.replyWithMarkdown(message);
  } catch (error) {
    console.error('Error sending chain info:', error);
    await ctx.reply('⚠️ Unable to display chain information. Please try again later.');
  }
}

/**
 * Send Chain Content (Base Only)
 * @param {Context} ctx
 * @param {number} index
 */
async function sendChainContent(ctx, index) {
  // Since we're only focusing on Base, pagination is not required.
  await sendChainInfo(ctx);
}

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
    await ctx.reply('⚠️ An error occurred. Please try again later.');
  }
});

// Generate Wallet Function using BlockRadar API
async function generateWallet(chain) {
  try {
    const response = await axios.post(
      `${chain.apiUrl}/wallets/${chain.id}/addresses`,
      { name: chain.walletName },
      { headers: { 'x-api-key': chain.key } }
    );
    return response.data.data.address;
  } catch (error) {
    throw new Error(`Error generating wallet on ${chain.name}: ${error.response ? error.response.data.message : error.message}`);
  }
}

// Wallet Generation Handlers

// Generate Wallet
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  try {
    // Present Chain Options
    const chainButtons = supportedChains.map((chain, index) => [
      Markup.button.callback(chain.name, `generate_wallet_${index}`),
    ]);

    await ctx.reply('Please select the blockchain network for which you want to generate a wallet:', Markup.inlineKeyboard(chainButtons));
  } catch (error) {
    console.error('Error presenting chain options:', error);
    await ctx.reply('⚠️ An error occurred while presenting chain options. Please try again later.');
  }
});

// Handle Wallet Generation based on Chain Selection
supportedChains.forEach((chain, index) => {
  bot.action(`generate_wallet_${index}`, async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    }

    const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

    try {
      const walletAddress = await generateWallet(chain);
      userState.wallets.push({ address: walletAddress, chain: chain.name, bank: null });

      // Update User State in Firestore
      await setUserState(userId, userState);

      // Add wallet mapping
      await addWalletMapping(walletAddress, userId, chain.name);

      // Update Menu with Detailed Wallet Information
      await ctx.replyWithMarkdown(`✅ Success! Your new wallet on *${chain.name}* has been generated:\n\n\`${walletAddress}\`\n\n*Supported Assets on ${chain.name}:* ${chain.supportedAssets.join(', ')}`, getMainMenu(true));

      // Prompt to Link Bank Account Immediately
      await ctx.reply('🔗 To receive payouts, please link a bank account to this wallet.', Markup.inlineKeyboard([
        Markup.button.callback('🏦 Link Bank Account', `link_bank_wallet_${userState.wallets.length - 1}`)
      ]));

      await ctx.deleteMessage(generatingMessage.message_id);

      // Log Wallet Generation
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain.name}: ${walletAddress}`);
    } catch (error) {
      console.error('Error generating wallet:', error);
      await ctx.reply(`⚠️ There was an issue generating your wallet on ${chain.name}. Please try again later.`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId} on ${chain.name}: ${error.message}`);
    }
  });
});

// View Wallet
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    return ctx.reply('You have no wallets. Generate a new wallet below.', getMainMenu(false));
  }

  try {
    // Display Wallets
    let walletMessage = '💼 **Your Wallets**:\n\n';
    userState.wallets.forEach((wallet, index) => {
      walletMessage += `#${index + 1} *${wallet.chain} Wallet*\n`;
      walletMessage += `Address: \`${wallet.address}\`\n`;
      walletMessage += `🔗 Linked Bank: ${wallet.bank ? 'Yes' : 'No'}\n\n`;
    });

    const canCreateNewWallet = userState.wallets.length < MAX_WALLETS;

    await ctx.replyWithMarkdown(walletMessage, Markup.inlineKeyboard([
      canCreateNewWallet
        ? [Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')]
        : [Markup.button.callback('⚠️ Wallet Limit Reached', 'wallet_limit_reached')],
    ]));
  } catch (error) {
    console.error('Error displaying wallets:', error);
    await ctx.reply('⚠️ Unable to display your wallets. Please try again later.');
  }
});

// Create New Wallet
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  try {
    // Present Chain Options
    const chainButtons = supportedChains.map((chain, index) => [
      Markup.button.callback(chain.name, `generate_new_wallet_${index}`),
    ]);

    await ctx.reply('Please select the blockchain network for which you want to generate a new wallet:', Markup.inlineKeyboard(chainButtons));
  } catch (error) {
    console.error('Error presenting chain options for new wallet:', error);
    await ctx.reply('⚠️ An error occurred while presenting chain options. Please try again later.');
  }
});

// Handle New Wallet Generation based on Chain Selection
supportedChains.forEach((chain, index) => {
  bot.action(`generate_new_wallet_${index}`, async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    }

    const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

    try {
      const walletAddress = await generateWallet(chain);
      userState.wallets.push({ address: walletAddress, chain: chain.name, bank: null });

      // Update User State in Firestore
      await setUserState(userId, userState);

      // Add wallet mapping
      await addWalletMapping(walletAddress, userId, chain.name);

      // Update Menu with Detailed Wallet Information
      await ctx.replyWithMarkdown(`✅ Success! Your new wallet on *${chain.name}* has been generated:\n\n\`${walletAddress}\`\n\n*Supported Assets on ${chain.name}:* ${chain.supportedAssets.join(', ')}`, getMainMenu(true));

      // Prompt to Link Bank Account Immediately
      await ctx.reply('🔗 To receive payouts, please link a bank account to this wallet.', Markup.inlineKeyboard([
        Markup.button.callback('🏦 Link Bank Account', `link_bank_wallet_${userState.wallets.length - 1}`)
      ]));

      await ctx.deleteMessage(generatingMessage.message_id);

      // Log Wallet Generation
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 New wallet generated for user ${userId} on ${chain.name}: ${walletAddress}`);
    } catch (error) {
      console.error('Error generating new wallet:', error);
      await ctx.reply(`⚠️ There was an issue generating your wallet on ${chain.name}. Please try again later.`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating new wallet for user ${userId} on ${chain.name}: ${error.message}`);
    }
  });
});

// Link Bank Account
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // Check if user has wallets
  if (userState.wallets.length === 0) {
    return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
  }

  try {
    // Present Wallet Options for Bank Linking
    const chainButtons = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`${wallet.chain} Wallet (${index + 1})`, `link_bank_wallet_${index}`),
    ]);

    await ctx.reply('Please select the wallet you want to link a bank account to:', Markup.inlineKeyboard(chainButtons));
  } catch (error) {
    console.error('Error presenting wallets for bank linking:', error);
    await ctx.reply('⚠️ An error occurred while presenting wallet options. Please try again later.');
  }
});

// Handle Bank Linking based on Wallet Selection
bot.action(/link_bank_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    return ctx.reply('⚠️ Invalid wallet selection. Please try again.');
  }

  // Update userState to indicate the user is awaiting bank details for the selected wallet
  userState.awaiting = { action: 'link_bank', walletIndex };
  await setUserState(userId, userState);

  await ctx.reply('Please enter your bank name (e.g., Access Bank):');
});

// Learn About Base (Exclusive)
bot.hears('📘 Learn About Base', async (ctx) => {
  await sendChainContent(ctx, 0);
});

// Handle Chain Content Pagination (Not Required for Single Chain)
bot.action(/chain_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  await sendChainContent(ctx, index);
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
    console.error('Error presenting support options:', error);
    await ctx.reply('⚠️ An error occurred while presenting support options. Please try again later.');
  }
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  try {
    await ctx.reply('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
  } catch (error) {
    console.error('Error handling support_how_it_works:', error);
    await ctx.reply('⚠️ An error occurred while providing support information. Please try again later.');
  }
});

bot.action('support_not_received', async (ctx) => {
  try {
    await ctx.reply('If you haven’t received your transaction, please ensure that you have linked a bank account. If the issue persists, contact support.');
  } catch (error) {
    console.error('Error handling support_not_received:', error);
    await ctx.reply('⚠️ An error occurred while providing support information. Please try again later.');
  }
});

bot.action('support_contact', async (ctx) => {
  try {
    await ctx.reply('You can contact our support team at @your_support_username.');
  } catch (error) {
    console.error('Error handling support_contact:', error);
    await ctx.reply('⚠️ An error occurred while providing support information. Please try again later.');
  }
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
      message += `*Reference ID:* ${tx.referenceId}\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n`;
      message += `*Chain:* ${tx.chain}\n\n`;
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
    // Fetch and display all transactions in an organized manner
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `🔹 *User ID:* ${tx.userId}\n`;
        message += `🔹 *Reference ID:* ${tx.referenceId}\n`;
        message += `🔹 *Amount:* ${tx.amount} ${tx.asset}\n`;
        message += `🔹 *Status:* ${tx.status || 'Pending'}\n`;
        message += `🔹 *Chain:* ${tx.chain}\n`;
        message += `🔹 *Date:* ${new Date(tx.timestamp).toLocaleString()}\n`;
        message += `🔹 *Transaction ID:* ${tx.transactionHash}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      await ctx.reply('⚠️ Unable to fetch transactions.');
    }
  } else if (action === 'send_message') {
    // Initiate send message flow
    const userState = await getUserState(userId);
    userState.awaiting = { action: 'send_message' };
    await setUserState(userId, userState);
    await ctx.reply('Please enter the User ID you want to message (e.g., 123456789):');
  } else if (action === 'send_image') {
    // Initiate send image flow
    const userState = await getUserState(userId);
    userState.awaiting = { action: 'send_image' };
    await setUserState(userId, userState);
    await ctx.reply('Please enter the User ID you want to send an image to (e.g., 123456789):');
  } else if (action === 'mark_paid') {
    // Fetch pending transactions and allow admin to select which to mark as paid
    try {
      const pendingTransactionsSnapshot = await db.collection('transactions').where('status', '==', 'Pending').get();

      if (pendingTransactionsSnapshot.empty) {
        return ctx.reply('No pending transactions found.');
      }

      const transactionButtons = [];
      pendingTransactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        transactionButtons.push([
          Markup.button.callback(`${tx.referenceId} - ${tx.amount} ${tx.asset} (${tx.chain})`, `mark_paid_${tx.referenceId}`),
        ]);
      });

      await ctx.reply('Select the transaction you want to mark as paid:', Markup.inlineKeyboard(transactionButtons));
    } catch (error) {
      console.error('Error fetching pending transactions:', error);
      await ctx.reply('⚠️ Unable to fetch pending transactions.');
    }
  }
});

// Handle Mark Paid Action
bot.action(/mark_paid_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const referenceId = ctx.match[1];

  try {
    const transactionSnapshot = await db.collection('transactions').where('referenceId', '==', referenceId).get();

    if (transactionSnapshot.empty) {
      return ctx.reply('⚠️ Transaction not found.');
    }

    const transactionDoc = transactionSnapshot.docs[0];
    const transactionData = transactionDoc.data();

    // Update transaction status to 'Paid'
    await db.collection('transactions').doc(transactionDoc.id).update({ status: 'Paid' });

    // Notify the user
    await bot.telegram.sendMessage(transactionData.userId, `🎉 Your transaction with Reference ID *${referenceId}* has been marked as *Paid*!`, { parse_mode: 'Markdown' });

    // Notify Admin
    await ctx.reply(`✅ Transaction *${referenceId}* has been marked as *Paid* and the user has been notified.`, { parse_mode: 'Markdown' });

    // Optionally, log the action
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `📝 Admin marked transaction ${referenceId} as Paid for user ${transactionData.userId}.`);
  } catch (error) {
    console.error('Error marking transaction as paid:', error);
    await ctx.reply('⚠️ Unable to mark transaction as paid. Please try again later.');
  }
});

// Handle Admin Messaging and Image Upload Flows
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // Admin Messaging Flow
  if (isAdmin(userId)) {
    if (userState.awaiting && userState.awaiting.action === 'send_message') {
      const recipientId = ctx.message.text.trim();
      if (!/^\d+$/.test(recipientId)) {
        return ctx.reply('❌ Invalid User ID. Please enter a valid numeric User ID (e.g., 123456789):');
      }

      userState.awaiting = { action: 'send_message_content', recipientId };
      await setUserState(userId, userState);
      return ctx.reply('Please enter the message you want to send:');
    } else if (userState.awaiting && userState.awaiting.action === 'send_message_content') {
      const recipientId = userState.awaiting.recipientId;
      const messageContent = ctx.message.text.trim();

      try {
        await bot.telegram.sendMessage(recipientId, `${messageContent}`);
        await ctx.reply('✅ Message sent successfully.');
      } catch (error) {
        console.error('Error sending message to user:', error);
        await ctx.reply('⚠️ Failed to send message to the user. Ensure the User ID is correct and the user has interacted with the bot.');
      }

      // Reset Admin State
      userState.awaiting = null;
      await setUserState(userId, userState);
      return;
    }
  }

  // Bank Linking Flow (Handled Earlier)
});

// Handle Image Upload by Admin
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (isAdmin(userId) && userState.awaiting && userState.awaiting.action === 'send_image') {
    const recipientId = userState.awaiting.recipientId;

    const photoArray = ctx.message.photo;
    const highestResPhoto = photoArray[photoArray.length - 1];
    const fileId = highestResPhoto.file_id;

    try {
      await bot.telegram.sendPhoto(recipientId, fileId, { caption: '', parse_mode: 'Markdown' });
      await ctx.reply('✅ Image sent successfully.');
    } catch (error) {
      console.error('Error sending image to user:', error);
      await ctx.reply('⚠️ Failed to send image to the user. Ensure the User ID is correct and the user has interacted with the bot.');
    }

    // Reset Admin State
    userState.awaiting = null;
    await setUserState(userId, userState);
  }
});

// Admin Send Image Flow Initiation
bot.action('admin_send_image', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  userState.awaiting = { action: 'send_image' };
  await setUserState(userId, userState);

  await ctx.reply('Please enter the User ID you want to send an image to (e.g., 123456789):');
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    console.log('Received webhook:', JSON.stringify(event, null, 2));
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Process only deposit.success events
    if (event.event === 'deposit.success') {
      const walletAddress = event.data.address.address;
      const amount = event.data.amount;
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;
      const chainName = event.data.chain; // Assuming chain info is part of the webhook event

      // Find User by Wallet Address using 'wallets' collection
      const walletDoc = await db.collection('wallets').doc(walletAddress).get();
      let userIdFromDB = null;

      if (walletDoc.exists) {
        userIdFromDB = walletDoc.data().userId;
      }

      if (!userIdFromDB) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const userState = await getUserState(userIdFromDB);
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userIdFromDB, `💰 Deposit Received: ${amount} ${asset} on *${chainName}*.\n\nPlease link a bank account to receive your payout securely.`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userIdFromDB} has received a deposit on ${chainName} but hasn't linked a bank account.`);
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      // Notify User of Successful Deposit
      await bot.telegram.sendMessage(userIdFromDB,
        `Hello ${wallet.bank.accountName},\n\nA deposit of ${amount} ${asset} on *${chainName}* was received on your wallet address: \`${walletAddress}\`.\n\nYour transaction is being processed. You’ll receive NGN ${payout} in your ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} shortly.\n\nWe'll notify you once the process is complete.`,
        Markup.inlineKeyboard([
          Markup.button.callback('📊 View Transaction', `view_transaction_${transactionHash}`)
        ])
      );

      // Notify Admin with Transaction Details in Organized Format
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID,
        `⚡️ *New Deposit Received*\n\n*User ID:* ${userIdFromDB}\n*Chain:* ${chainName}\n*Amount:* ${amount} ${asset}\n*Wallet Address:* ${walletAddress}\n*Reference ID:* ${referenceId}\n*Transaction Hash:* ${transactionHash}\n*Payout (NGN):* ${payout}\n\nProcessing payout to ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)}.`,
        { parse_mode: 'Markdown' }
      );

      // Store Transaction in Firebase
      await db.collection('transactions').add({
        userId: userIdFromDB,
        walletAddress,
        chain: chainName,
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
