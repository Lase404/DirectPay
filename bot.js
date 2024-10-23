// DIRECTPAY-TG-BOT//
// DEV: TOLUWALASE ADUNBI//
//-----------------------//
///--------MODULES👇-------//
const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const ratesManager = require('./rates.js'); 

//  Environment Variables
require('dotenv').config();

//  Winston Logger
const logger = winston.createLogger({
  level: 'info', // Change to 'debug' for more detailed logs
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ],
});

// Firebase Setup
const serviceAccount = require('./directpay.json'); // Ensure this file is secured on the server
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// Configuration & API Keys
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYSTACK_API_KEY = process.env.PAYSTACK_API_KEY;
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_WALLETS = 5;

// Multi-Chain Wallet Configuration with Blockradar's API
const chains = {
  Base: {
    id: '83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d',
    key: 'grD8lJpMPjvjChMo5SnOl0eZmaabikn2z2S2rXKkAxCM1oWsZDMwFQL9LWgrc',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base'
  },
  Polygon: {
    id: 'f7d5b102-e94a-493a-8e0c-8da96fe70655',
    key: 'iXV8e72v9QLKcKfI4Nw8SkqKtEoyzAQFCFinIZKwj7pKUtFxaRMjlLCt5p3DZND',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/f7d5b102-e94a-493a-8e0c-8da96fe70655/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon'
  },
  'BNB Smart Chain': {
    id: '2cab1ef2-8589-4ff9-9017-76cc4d067719',
    key: '6HGRj2cdzULDUbrjGHZftwNyHswUZojxA40mQp77e5vDzWqJ6v13w2iE4DBHzu',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/2cab1ef2-8589-4ff9-9017-76cc4d067719/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain'
  }
};

// Web3 Setup for Base Testnet
const Web3 = require('web3');
const web3 = new Web3('https://sepolia.base.org');

// Initialize Express App for Webhooks
const app = express();
app.use(express.json());

//-------TELEGRAF SESSION & HANDLERS-----//

// Initialize Telegraf Bot with Session Middleware
const bot = new Telegraf(BOT_TOKEN);

// Use Session Middleware
bot.use(session());

// Bank List with Names, Codes, and Aliases
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'] },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtb', 'guaranty trust bank'] },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'] },
  { name: 'First Bank', code: '011', aliases: ['first bank', 'firstbank', 'fbank', 'first bank nigeria'] },
  { name: 'UBA', code: '033', aliases: ['uba', 'united bank for africa', 'uba nigeria'] },
  { name: 'Polaris Bank', code: '076', aliases: ['polaris', 'polaris bank', 'polarisb', 'polaris bank nigeria'] },
  { name: 'Fidelity Bank', code: '070', aliases: ['fidelity', 'fidelity bank', 'fidelityb', 'fidelity bank nigeria'] },
  { name: 'Ecobank', code: '050', aliases: ['ecobank', 'ecobank nigeria', 'eco bank'] },
  { name: 'Union Bank', code: '032', aliases: ['union', 'union bank', 'unionb', 'union bank nigeria'] },
  { name: 'Stanbic IBTC Bank', code: '221', aliases: ['stanbic', 'stanbic ibtc', 'stanbic bank', 'stanbic ibtc nigeria'] },
  { name: 'Standard Chartered Bank', code: '068', aliases: ['standard chartered', 'standard bank', 'standard chartered nigeria'] },
  { name: 'Sterling Bank', code: '232', aliases: ['sterling', 'sterling bank', 'sterlingb', 'sterling bank nigeria'] },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'] },
  { name: 'Keystone Bank', code: '082', aliases: ['keystone', 'keystone bank', 'keystoneb', 'keystone bank nigeria'] },
  { name: 'Unity Bank', code: '215', aliases: ['unity', 'unity bank', 'unityb', 'unity bank nigeria'] },
  { name: 'Heritage Bank', code: '030', aliases: ['heritage', 'heritage bank', 'heritageb', 'heritage bank nigeria'] },
  { name: 'FCMB', code: '214', aliases: ['fcmb', 'first city monument bank', 'fcmb nigeria'] },
  { name: 'Jaiz Bank', code: '301', aliases: ['jaiz', 'jaiz bank', 'jaizb', 'jaiz bank nigeria'] },
  { name: 'Parallex Bank', code: '104', aliases: ['parallex', 'parallex bank', 'parallexb', 'parallex bank nigeria'] },
  { name: 'Kuda Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'] },
  { name: 'Providus Bank', code: '101', aliases: ['providus', 'providus bank', 'providusb', 'providus bank nigeria'] },
  { name: 'ALAT by WEMA', code: '035A', aliases: ['alat', 'alat by wema', 'alat nigeria'] },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'] },
  { name: 'Paycom', code: '999992', aliases: ['paycom', 'paycom nigeria'] }
];

// Verify Bank Account with Paystack
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.message}`);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

// Calculate Payout Based on Asset Type Using Dynamic Rates
async function calculatePayout(asset, amount) {
  try {
    const currentRates = await ratesManager.getRates();
    if (!currentRates || !currentRates[asset]) {
      throw new Error(`Unsupported or unavailable rate for asset: ${asset}`);
    }
    return (amount * currentRates[asset]).toFixed(2);
  } catch (error) {
    logger.error(`Error calculating payout: ${error.message}`);
    throw error;
  }
}

// Generate a Unique Reference ID for Transactions
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Main Menu Dynamically Updated Based on Wallet and Bank Status
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '🏦 Edit Bank Account' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // New button added
  ]).resize();

// Admin Menu
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View All Transactions', 'admin_view_transactions')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📩 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('🏦 Manage Banks', 'admin_manage_banks')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// Check if User is Admin
const isAdmin = (userId) => ADMIN_IDS.includes(userId.toString());

// Firestore Helper Functions

// Get User State from Firestore
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      // Initialize user state if not exists with all necessary properties
      await db.collection('users').doc(userId).set({
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false, // For admin broadcast
        username: 'No Username',
      });
      return {
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        username: 'No Username',
      };
    } else {
      const data = userDoc.data();
      // Ensure all properties are defined, else set default values
      return {
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
        username: data.username || 'No Username',
      };
    }
  } catch (error) {
    logger.error(`Error getting user state for ${userId}: ${error.message}`);
    throw error;
  }
}

// Update User State in Firestore
async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

// Greet User
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? `👋 Hello, ${ctx.from.first_name}!\n\nWelcome back to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Quick Start Guide:**\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : `👋 Welcome, ${ctx.from.first_name}!\n\nThank you for choosing **DirectPay**. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
    ]));
    ctx.session.adminMessageId = sentMessage.message_id;
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const username = ctx.from.username || 'No Username';

    // Fetch or initialize user state
    let userState = await getUserState(userId);

    // If the user just joined, update their username
    if (userState.username !== username) {
      await updateUserState(userId, { username });
    }

    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// Generate Wallet Function
async function generateWallet(chain) {
  try {
    const response = await axios.post(
      chains[chain].apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chains[chain].key } }
    );
    const walletAddress = response.data.data.address;
    if (!walletAddress) {
      throw new Error('Wallet address not returned from Blockradar.');
    }
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
    throw new Error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
  }
}

// Wallet Generation Handler
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const selectedChainKey = ctx.match[1]; // 'Base', 'Polygon', 'BNB Smart Chain'

  // Validate Selected Chain
  if (!chains[selectedChainKey]) {
    await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
    return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
  }

  const chain = selectedChainKey;

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();

  // Inform User That Wallet Generation Has Started
  const generatingMessage = await ctx.replyWithMarkdown(`🔄 Generating Wallet for *${chain}*... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain);

    // Fetch Updated User State
    const userState = await getUserState(userId);

    // Add the New Wallet to User State
    userState.wallets.push({
      address: walletAddress || 'N/A',
      chain: chain || 'N/A',
      supportedAssets: chains[chain].supportedAssets ? [...chains[chain].supportedAssets] : [],
      bank: null
    });

    // Also, Add the Wallet Address to walletAddresses Array
    const updatedWalletAddresses = userState.walletAddresses || [];
    updatedWalletAddresses.push(walletAddress);

    // Update User State in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: updatedWalletAddresses,
    });

    // Update Menu
    await ctx.replyWithMarkdown(`✅ Success! Your new wallet has been generated on **${chain}**:\n\n\`${walletAddress}\`\n\n**Supported Assets:** ${chains[chain].supportedAssets.join(', ')}`, getMainMenu(true, false));

    // **Automatically initiate bank linking for the newly created wallet**
    const newWalletIndex = userState.wallets.length - 1; // Index of the newly added wallet
    ctx.session.walletIndex = newWalletIndex;
    ctx.session.processType = 'linking'; // Indicate that this is a linking process

    // **Initiate the bank linking process**
    await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');

    // Set a timeout for inactivity (e.g., 5 minutes)
    ctx.session.bankLinkingTimeout = setTimeout(async () => {
      if (ctx.session.isBankLinking) {
        await ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        delete ctx.session.walletIndex;
        delete ctx.session.processType;
        delete ctx.session.isBankLinking;
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// Generate Wallet Button Handler
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  // Prompt User to Select a Network
  await ctx.replyWithMarkdown('Please choose the network you want to generate a wallet for:', Markup.inlineKeyboard([
    [Markup.button.callback('Base', 'generate_wallet_Base')],
    [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
    [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
  ]));
});

// View Wallet
bot.hears(/💼\s*View Wallet/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.wallets.length === 0) {
    return await ctx.replyWithMarkdown('You have no wallets linked. Generate a wallet below.', getMainMenu(false, false));
  }

  // Display Wallet and Bank Details
  let walletMessage = '💼 *Your Wallets and Linked Bank Accounts*:\n\n';
  userState.wallets.forEach((wallet, index) => {
    const bank = wallet.bank ? `
🔗 *Linked Bank:* ${wallet.bank.bankName}
🔢 *Account Number:* ****${wallet.bank.accountNumber.slice(-4)}
👤 *Account Name:* ${wallet.bank.accountName}
` : '❌ No bank linked\n';

    walletMessage += `*#${index + 1} Wallet Address:* \`${wallet.address}\`\n${bank}\n`;
  });

  // **Add inline buttons: Create New Wallet**
  const inlineButtons = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')],
  ]);

  await ctx.replyWithMarkdown(walletMessage, inlineButtons);
});

// Handler for "Create New Wallet" Button
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    return ctx.answerCbQuery(); // Acknowledge the callback
  }

  // Prompt the user to select a network
  await ctx.replyWithMarkdown('Please choose the network you want to generate a wallet for:', Markup.inlineKeyboard([
    [Markup.button.callback('Base', 'generate_wallet_Base')],
    [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
    [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
  ]));
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Handle Editing Bank Account Options
bot.hears(/🏦\s*Edit Bank Account/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.wallets.length === 0) {
    return await ctx.replyWithMarkdown('⚠️ You have no wallets linked. Please generate a wallet first.', getMainMenu(false, false));
  }

  // Prompt user to select which wallet to edit
  let selectionMessage = '✏️ *Select a Wallet to Edit Its Bank Account*:\n\n';
  userState.wallets.forEach((wallet, index) => {
    selectionMessage += `*Wallet ${index + 1}:* ${wallet.address.slice(0, 3)}...${wallet.address.slice(-4)}\n`;
  });

  await ctx.replyWithMarkdown(selectionMessage, Markup.inlineKeyboard(
    userState.wallets.map((wallet, index) => [Markup.button.callback(`Wallet ${index + 1}`, `edit_wallet_${index}`)])
  ));
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Handle Selecting a Wallet to Edit
bot.action(/edit_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (!userState.wallets[walletIndex] || !userState.wallets[walletIndex].bank) {
    await ctx.replyWithMarkdown('❌ No linked bank account found for the selected wallet.');
    return ctx.answerCbQuery(); // Acknowledge the callback
  }

  // Store the wallet index in session for editing
  ctx.session.walletIndex = walletIndex;

  // Prompt for new bank name
  await ctx.replyWithMarkdown('🏦 Please enter your new bank name (e.g., Access Bank):');

  // Acknowledge the callback
  ctx.answerCbQuery();

  // Set a timeout for inactivity (e.g., 5 minutes)
  ctx.session.bankLinkingTimeout = setTimeout(async () => {
    if (ctx.session.isBankLinking) {
      await ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      delete ctx.session.walletIndex;
      delete ctx.session.processType;
      delete ctx.session.isBankLinking;
    }
  }, 5 * 60 * 1000); // 5 minutes
});

// Handle Bank Linking Input (for both linking and editing)
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  // Handle Broadcast Message
  if (userState.awaitingBroadcastMessage) {
    const broadcastMessage = ctx.message.text.trim();
    if (!broadcastMessage) {
      return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
    }

    try {
      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await bot.telegram.sendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${broadcastMessage}`, { parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);
    } catch (error) {
      logger.error(`Error broadcasting message from admin ${userId}: ${error.message}`);
      await ctx.reply('⚠️ Error broadcasting message. Please try again later.', getAdminMenu());
    }

    // Reset broadcast message state
    await updateUserState(userId, { awaitingBroadcastMessage: false });
    return;
  }

  // Handle Bank Linking (Both Linking and Editing)
  if (ctx.session.walletIndex !== undefined) {
    const input = ctx.message.text.trim();

    // Clear the inactivity timeout
    if (ctx.session.bankLinkingTimeout) {
      clearTimeout(ctx.session.bankLinkingTimeout);
      delete ctx.session.bankLinkingTimeout;
    }

    // Find the selected wallet
    const walletIndex = ctx.session.walletIndex;
    const wallet = userState.wallets[walletIndex];

    if (!wallet) {
      await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
      delete ctx.session.walletIndex;
      return;
    }

    // Process Bank Name
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:');
    }

    // Prompt for Account Number
    ctx.session.bankData = {
      bankName: bank.name,
      bankCode: bank.code
    };

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');

    // Set a new timeout for the next input
    ctx.session.bankLinkingTimeout = setTimeout(async () => {
      if (ctx.session.isBankLinking) {
        await ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        delete ctx.session.walletIndex;
        delete ctx.session.bankData;
        delete ctx.session.isBankLinking;
      }
    }, 5 * 60 * 1000); // 5 minutes

    return;
  }

  if (ctx.session.bankData && ctx.session.walletIndex !== undefined) {
    const userId = ctx.from.id.toString();
    const accountNumber = ctx.message.text.trim();

    // Validate Account Number
    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    ctx.session.bankData.accountNumber = accountNumber;

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, ctx.session.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;

      if (!accountName) {
        throw new Error('Unable to retrieve account name.');
      }

      ctx.session.bankData.accountName = accountName;

      // Confirm Details
      await ctx.replyWithMarkdown(
        `🏦 *Bank Account Verification*\n\n` +
        `Please confirm your bank details:\n` +
        `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
        `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
        `- *Account Holder:* ${accountName}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
          [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
        ])
      );
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.reply('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      // Reset session variables
      delete ctx.session.walletIndex;
      delete ctx.session.bankData;
    }

    return;
  }

  await next(); // Pass control to the next handler
});

// Confirm Bank Account
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  logger.info(`User ${userId} confirmed bank linking/editing. Wallet Index: ${walletIndex}`);

  try {
    let userState = await getUserState(userId);

    // Update Bank Details for the Selected Wallet
    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    // Update User State in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    // Prepare Confirmation Message
    let confirmationMessage = `✅ *Bank Account Updated Successfully!*\n\n`;
    confirmationMessage += `*Bank Name:* ${bankData.bankName}\n`;
    confirmationMessage += `*Account Number:* ${bankData.accountNumber}\n`;
    confirmationMessage += `*Account Holder:* ${bankData.accountName}\n\n`;
    confirmationMessage += `You can view your updated bank details using the "💼 View Wallet" option.`;

    await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(true, true));

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} updated a bank account:\n\n` +
      `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n` +
      `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
      `*Account Number:* ${userState.wallets[walletIndex].bank.accountNumber}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} updated a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    // Reset Session Variables
    delete ctx.session.walletIndex;
    delete ctx.session.bankData;
    delete ctx.session.isBankLinking;

    ctx.replyWithMarkdown('Your bank account has been successfully updated!');
  } catch (error) {
    logger.error(`Error confirming bank account update for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An unexpected error occurred while processing your request. Please try again later.');
  }
});

// Decline Bank Account Confirmation
bot.action('confirm_bank_no', async (ctx) => {
  await ctx.reply('⚠️ Let\'s try again.');

  // Reset Bank Data and Restart the Process
  delete ctx.session.bankData;
  delete ctx.session.walletIndex;
  delete ctx.session.isBankLinking;

  ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Handle Cancellation of Bank Linking
bot.action('cancel_bank_linking', async (ctx) => {
  await ctx.reply('❌ Bank linking process has been canceled.');

  // Clean Up Session Variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.isBankLinking;

  ctx.answerCbQuery(); // Acknowledge the callback
});

// Handle Bank Management (Coming Soon)
bot.action('manage_banks', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
});

// Handle Back to Main Menu
bot.action('admin_back_to_main', async (ctx) => {
  await ctx.answerCbQuery();
  await greetUser(ctx);
  // Delete the admin panel message if exists
  if (ctx.session.adminMessageId) {
    await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
    ctx.session.adminMessageId = null;
  }
});

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return await ctx.replyWithMarkdown('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  if (action === 'view_transactions') {
    // Handle viewing all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

      if (transactionsSnapshot.empty) {
        await ctx.editMessageText('📋 *Recent Transactions*\n\nNo transactions found.', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
        return ctx.answerCbQuery();
      }

      let message = '📋 *Recent Transactions*:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `*User ID:* ${tx.userId || 'N/A'}\n`;
        message += `*Username:* @${tx.username || 'No Username'}\n`;
        message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        message += `*Status:* ${tx.status || 'Pending'}\n`;
        message += `*Chain:* ${tx.chain || 'N/A'}\n`;
        message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
      });

      // Add a 'Back' Button to Return to the Admin Menu
      const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
      ]);

      // Edit the Admin Panel Message
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
      ctx.answerCbQuery();
    } catch (error) {
      logger.error(`Error fetching all transactions: ${error.message}`);
      await ctx.editMessageText('⚠️ Unable to fetch transactions.', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      ctx.answerCbQuery();
    }
  } else if (action === 'view_users') {
    // Fetch and display all users
    try {
      const usersSnapshot = await db.collection('users').get();

      if (usersSnapshot.empty) {
        await ctx.editMessageText('👥 **All Users**:\n\nNo users found.', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
        return ctx.answerCbQuery();
      }

      let message = '👥 **All Users**:\n\n';

      usersSnapshot.forEach((doc) => {
        const user = doc.data();
        message += `*User ID:* ${doc.id}\n`;
        message += `*Username:* @${user.username}\n`;
        message += `*Number of Wallets:* ${user.wallets.length}\n`;
        message += `*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
      });

      // Add a 'Back' button to return to the admin menu
      const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
      ]);

      // Edit the admin panel message
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
      ctx.answerCbQuery();
    } catch (error) {
      logger.error(`Error fetching all users: ${error.message}`);
      await ctx.editMessageText('⚠️ Unable to fetch users.', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      ctx.answerCbQuery();
    }
  } else if (action === 'broadcast_message') {
    await ctx.answerCbQuery();
    await ctx.reply('📢 Please enter the message you want to broadcast to all users:');
    // Set state to indicate awaiting broadcast message
    await updateUserState(userId, { awaitingBroadcastMessage: true });
    // Delete the admin panel message to keep chat clean
    if (ctx.session.adminMessageId) {
      await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  } else if (action === 'manage_banks') {
    // Implement bank management functionalities here
    await ctx.answerCbQuery();
    await ctx.editMessageText('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
  } else if (action === 'admin_back_to_main') {
    // Return to the main menu
    await ctx.answerCbQuery();
    await greetUser(ctx);
    // Delete the admin panel message
    if (ctx.session.adminMessageId) {
      await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  } else {
    await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// Handle Broadcast Message Input
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.awaitingBroadcastMessage) {
    const broadcastMessage = ctx.message.text.trim();
    if (!broadcastMessage) {
      return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
    }

    try {
      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      // Implementing Rate Limiting: Send messages in batches with delays
      const batchSize = 30; // Number of messages per batch
      const delayBetweenBatches = 2000; // 2 seconds delay between batches

      const users = usersSnapshot.docs.map(doc => ({
        userId: doc.id,
        username: doc.data().username || 'No Username'
      }));

      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await Promise.all(batch.map(async (user) => {
          try {
            await bot.telegram.sendMessage(user.userId, `📢 *Broadcast Message:*\n\n${broadcastMessage}`, { parse_mode: 'Markdown' });
            successCount++;
          } catch (error) {
            failureCount++;
            logger.error(`Error sending broadcast to user ${user.userId} (@${user.username}): ${error.message}`);
          }
        }));

        // Delay before sending the next batch
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);
    } catch (error) {
      logger.error(`Error broadcasting message from admin ${userId}: ${error.message}`);
      await ctx.reply('⚠️ Error broadcasting message. Please try again later.', getAdminMenu());
    }

    // Reset broadcast message state
    await updateUserState(userId, { awaitingBroadcastMessage: false });
  }

  await next(); // Pass control to the next handler
});

// Add the New "View Current Rates" Command
bot.hears(/📈\s*View Current Rates/i, async (ctx) => {
  try {
    const currentRates = await ratesManager.getRates();

    if (!currentRates) {
      throw new Error('Rates data is unavailable.');
    }

    let ratesMessage = `📈 *Current Exchange Rates:*\n\n`;
    ratesMessage += `- *USDC:* ₦${currentRates.USDC} per USDC\n`;
    ratesMessage += `- *USDT:* ₦${currentRates.USDT} per USDT\n`;
    ratesMessage += `- *ETH:* ₦${currentRates.ETH} per ETH\n\n`;
    ratesMessage += `*Note:* These rates are updated every 5 minutes for accuracy.`;

    await ctx.replyWithMarkdown(ratesMessage);
  } catch (error) {
    logger.error(`Error fetching current rates: ${error.message}`);
    await ctx.reply('⚠️ Unable to fetch current rates. Please try again later.');
  }
});

// Learn About Base with Pagination and Inline Updates
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
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Bridge Assets to Base](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Documentation](https://docs.base.org) for in-depth guides and resources.',
  },
];

// Start the "Learn About Base" Section
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// Function to Send Base Content with Pagination and Inline Updates
async function sendBaseContent(ctx, index, isNew = false) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

  if (isNew) {
    const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
    // Store the message ID in session
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }

  // Set a timeout to delete the message after 2 minutes
  setTimeout(() => {
    if (ctx.session.baseMessageId) {
      ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
      ctx.session.baseMessageId = null;
    }
  }, 120000); // Delete after 2 minutes
}

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit the "Learn About Base" Section
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.reply('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// Support Functionality
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('How can we assist you today?', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
});

bot.action('support_not_received', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
});

bot.action('support_contact', async (ctx) => {
  await ctx.replyWithMarkdown('You can contact our support team at [@your_support_username](https://t.me/your_support_username).');
});

// Function to Send Detailed Tutorials in Support Section
const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.

2. **Link Your Bank Account:**
   - Go to "🏦 Link Bank Account."
   - Provide your bank details to securely receive payouts directly into your bank account.

3. **Receive Payments:**
   - Share your wallet address with clients or payment sources.
   - Once a deposit is made, DirectPay will automatically convert the crypto to NGN at current exchange rates.

4. **Monitor Transactions:**
   - Use the "💰 Transactions" option to view all your deposit and payout activities.

5. **Support & Assistance:**
   - Access detailed support tutorials anytime from the "ℹ️ Support" section.

**🔒 Security:**
Your funds are secure with us. We utilize industry-standard encryption and security protocols to ensure your assets and information remain safe.

**💬 Need Help?**
Visit the support section or contact our support team at [@your_support_username](https://t.me/your_support_username) for any assistance.
`,
  transaction_guide: `
**💰 Transaction Not Received?**

If you haven't received your transaction, follow these steps to troubleshoot:

1. **Verify Wallet Address:**
   - Ensure that the sender used the correct wallet address provided by DirectPay.

2. **Check Bank Linking:**
   - Make sure your bank account is correctly linked under "💼 View Wallet."
   - If not linked, go to "🏦 Link Bank Account" to add your bank details.

3. **Monitor Transaction Status:**
   - Use the "💰 Transactions" section to check the status of your deposit.
   - Pending status indicates that the deposit is being processed.

4. **Wait for Confirmation:**
   - Deposits might take a few minutes to reflect depending on the network congestion.

5. **Contact Support:**
   - If the issue persists after following the above steps, reach out to our support team at [@your_support_username](https://t.me/your_support_username) with your transaction details for further assistance.
`,
};

// Support: How to Link or Edit Your Bank Account
const detailedBankTutorial = {
  link_bank_tutorial: `
**🏦 How to Link or Edit Your Bank Account**

*Linking a New Bank Account:*

1. **Navigate to Bank Linking:**
   - Click on "🏦 Link Bank Account" from the main menu.

2. **Select Your Wallet:**
   - If you have multiple wallets, select the one you want to link a bank account to.

3. **Provide Bank Details:**
   - Enter your bank name (e.g., Access Bank).
   - Input your 10-digit bank account number.

4. **Verify Account:**
   - DirectPay will verify your bank account details.
   - Confirm the displayed account holder name.

5. **Completion:**
   - Once verified, your bank account is linked and ready to receive payouts.

*Editing an Existing Bank Account:*

1. **Navigate to Bank Editing:**
   - Click on "🏦 Edit Bank Account" from the main menu.

2. **Select the Wallet:**
   - Choose the wallet whose bank account you wish to edit.

3. **Provide New Bank Details:**
   - Enter the updated bank name or account number as required.

4. **Verify Changes:**
   - Confirm the updated account holder name.

5. **Completion:**
   - Your bank account details have been updated successfully.
`,
};

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract Common Event Data
    const eventType = event?.event || 'Unknown Event';
    const walletAddress = event?.data?.recipientAddress || null;
    const amount = parseFloat(event?.data?.amount) || 0;
    const asset = event?.data?.asset?.symbol || null;
    const transactionHash = event?.data?.hash || null;
    const chain = event?.data?.blockchain?.name || null;

    if (eventType === 'deposit.success') {
      if (!walletAddress) {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // Find User by Wallet Address
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        // Notify Admin About the Unmatched Wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();

      const wallet = userState.wallets?.find(w => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet?.bank) {
        await bot.telegram.sendMessage(userId, `💰 Deposit Received: ${amount} ${asset} on ${chain}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} (@${userState.username}) has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Fetch Current Rates
      const currentRates = await ratesManager.getRates();

      if (!currentRates || !currentRates[asset]) {
        throw new Error(`Unsupported or unavailable rate for asset: ${asset}`);
      }

      const rate = currentRates[asset];
      const payout = (amount * rate).toFixed(2);
      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'Valued User';

      // Notify User of Successful Deposit
      await bot.telegram.sendMessage(userId,
        `Dear ${accountName},\n\n` +
        `🎉 *Deposit Received*\n` +
        `- *Amount:* ${amount} ${asset}\n` +
        `- *Chain:* ${chain}\n` +
        `- *Wallet Address:* \`${walletAddress}\`\n\n` +
        `We are processing your transaction at a rate of *NGN ${rate}* per ${asset}.\n` +
        `You will receive *NGN ${payout}* in your ${bankName} account ending with ****${bankAccount.slice(-4)} shortly.\n\n` +
        `Thank you for using *DirectPay*. We appreciate your trust in our services.\n\n` +
        `*Note:* If you have any questions, feel free to reach out to our support team.`,
        { parse_mode: 'Markdown' }
      );

      // Notify Admin with Detailed Transaction Information
      const adminDepositMessage = `⚡️ *New Deposit Received*:\n\n` +
        `*User ID:* ${userId}\n` +
        `*Username:* @${userState.username}\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Exchange Rate:* NGN ${rate} per ${asset}\n` +
        `*Amount to be Paid:* NGN ${payout}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank Name:* ${bankName}\n` +
        `  - *Account Number:* ****${bankAccount.slice(-4)}\n` +
        `*Chain:* ${chain}\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` +
        `*Reference ID:* ${referenceId}\n`;

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      // Store Transaction in Firestore
      await db.collection('transactions').add({
        userId,
        walletAddress,
        chain,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        timestamp: new Date().toISOString(),
        status: 'Pending',
      });

      logger.info(`Transaction stored for user ${userId} (@${userState.username}): Reference ID ${referenceId}`);
      logger.info(`User @${userState.username} (ID: ${userId}) deposited ${amount} ${asset} on ${chain}.`);
      return res.status(200).send('OK');
    } else {
      // Handle Other Event Types if Necessary
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `ℹ️ *Unhandled event type:* ${eventType}`, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing webhook: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// Admin Functions

// Entry Point for Admin Panel
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return await ctx.replyWithMarkdown('⚠️ Unauthorized access.');
  }

  // Reset Session Variables if Necessary
  ctx.session.adminMessageId = null;

  const sentMessage = await ctx.replyWithMarkdown('👨‍💼 *Admin Panel*\n\nSelect an option below:', getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;

  // Set a Timeout to Delete the Admin Panel Message After 5 Minutes
  setTimeout(() => {
    if (ctx.session.adminMessageId) {
      ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  }, 300000); // Delete after 5 minutes
});

// Admin: Mark Transactions as Paid
bot.action('admin_mark_paid', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return await ctx.replyWithMarkdown('⚠️ Unauthorized access.');
  }

  try {
    const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
    if (pendingTransactions.empty) {
      await ctx.editMessageText('✅ All transactions are already marked as paid.', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      return ctx.answerCbQuery();
    }

    const batch = db.batch();
    pendingTransactions.forEach((transaction) => {
      const docRef = db.collection('transactions').doc(transaction.id);
      batch.update(docRef, { status: 'Paid' });
    });

    await batch.commit();

    // Notify Users About Their Transactions Being Marked as Paid
    for (const transaction of pendingTransactions.docs) {
      const data = transaction.data();
      try {
        // Fetch Current Rates at the Time of Payout
        const currentRates = await ratesManager.getRates();
        const payout = await calculatePayout(data.asset, data.amount);

        // Safely Access accountName
        const accountName = data.bankDetails && data.bankDetails.accountName ? data.bankDetails.accountName : 'Valued User';

        await bot.telegram.sendMessage(
          data.userId,
          `🎉 *Transaction Successful!*\n\n` +
          `*Reference ID:* \`${data.referenceId || 'N/A'}\`\n` +
          `*Amount Paid:* ${data.amount} ${data.asset}\n` +
          `*Bank:* ${data.bankDetails.bankName || 'N/A'}\n` +
          `*Account Name:* ${accountName}\n` +
          `*Account Number:* ****${data.bankDetails.accountNumber.slice(-4)}\n` +
          `*Payout (NGN):* ₦${payout}\n\n` +
          `🔹 *Chain:* ${data.chain}\n` +
          `*Date:* ${new Date(data.timestamp).toLocaleString()}\n\n` +
          `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/your_support_username).`,
          { parse_mode: 'Markdown' }
        );
        logger.info(`Notified user @${data.username} (ID: ${data.userId}) about paid transaction ${data.referenceId}`);
      } catch (error) {
        logger.error(`Error notifying user ${data.userId}: ${error.message}`);
      }
    }

    // Edit the Admin Panel Message to Confirm
    await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error marking transactions as paid: ${error.message}`);
    await ctx.editMessageText('⚠️ Error marking transactions as paid. Please try again later.', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
    ctx.answerCbQuery();
  }
});

// View Transactions for Users
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').get();

    if (transactionsSnapshot.empty) {
      return await ctx.replyWithMarkdown('You have no transactions at the moment.');
    }

    let message = '💰 *Your Transactions*:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Function to Send Base Content (Reused)
async function sendBaseContent(ctx, index, isNew = false) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

  if (isNew) {
    const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
    // Store the message ID in session
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }

  // Set a timeout to delete the message after 2 minutes
  setTimeout(() => {
    if (ctx.session.baseMessageId) {
      ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
      ctx.session.baseMessageId = null;
    }
  }, 120000); // Delete after 2 minutes
}

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit the "Learn About Base" Section
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.reply('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// Initialize RatesManager
ratesManager.init().catch(error => {
  logger.error(`Failed to initialize ratesManager: ${error.message}`);
  process.exit(1);
});

// Function to Handle Bank Linking Process (Both Linking and Editing)
async function handleBankLinking(ctx, userId, bankName) {
  const userState = await getUserState(userId);
  const walletIndex = ctx.session.walletIndex;

  const bank = bankList.find(b => b.aliases.includes(bankName.toLowerCase()));

  if (!bank) {
    await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:');
    return;
  }

  // Prompt for Account Number
  ctx.session.bankData = {
    bankName: bank.name,
    bankCode: bank.code
  };

  await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');
}
// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});

// Launch Bot
bot.launch()
  .then(() => logger.info('DirectPay bot is live!'))
  .catch((err) => {
    logger.error(`Error launching bot: ${err.message}`);
    process.exit(1); // Exit the process if bot fails to launch
  });

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

