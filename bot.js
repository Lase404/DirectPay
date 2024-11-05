// DIRECTPAY-TG-BOT//
// DEV: TOLUWALASE ADUNBI//
//-----------------------//
///--------MODULES👇-------//
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Environment Variables
require('dotenv').config();

// Winston Logger Configuration
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
const serviceAccount = require('./directpay.json'); //  this file is secured on the server
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

// Telegram Webhook Configuration
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook'; 
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const TELEGRAM_WEBHOOK_URL = `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;

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

// Initialize Express App for Webhooks
const app = express();
app.use(express.json());

// Initialize Telegraf Bot with Session and Stage Middleware
const bot = new Telegraf(BOT_TOKEN);

// Stage for Admin Actions and Bank Linking Using Telegraf Scenes
const stage = new Scenes.Stage();

// Bank Linking Scene (Handles Both Linking and Editing)
const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');

// Send Message Scene (Handles Text and Images)
const sendMessageScene = new Scenes.BaseScene('send_message_scene');

// Payment Request Scene (Handles Payment Requests)
const paymentRequestScene = new Scenes.BaseScene('payment_request_scene');


// Register Scenes
stage.register(bankLinkingScene);
stage.register(sendMessageScene);
stage.register(paymentRequestScene);


// Use Session Middleware
bot.use(session());

// Use the Stage Middleware
bot.use(stage.middleware());

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

// Calculate Payout Based on Asset Type Using Hardcoded Rates (Only for Webhook)
function calculatePayout(asset, amount) {
  const hardcodedRates = { USDC: 1690, USDT: 1690, ETH: 4300000 };
  const rate = hardcodedRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return (amount * rate).toFixed(2);
}

// Generate a Unique Reference ID for Transactions
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Function to Fetch Dynamic Rates from CoinGecko
async function fetchDynamicRates() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'usd-coin,tether,ethereum',
        vs_currencies: 'ngn',
      },
    });
    const rates = {
      USDC: response.data['usd-coin'].ngn,
      USDT: response.data['tether'].ngn,
      ETH: response.data['ethereum'].ngn,
    };
    return rates;
  } catch (error) {
    logger.error(`Error fetching dynamic rates from CoinGecko: ${error.message}`);
    throw new Error('Failed to fetch dynamic rates.');
  }
}

// Main Menu Dynamically Updated Based on Wallet and Bank Status
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '🏦 Edit Bank Account' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates', '📤 Send Payment Request'],
  ]).resize();

// Admin Menu
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View All Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📩 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🏦 Manage Banks', 'admin_manage_banks')],
    [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')],
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
      });
      return {
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
    } else {
      const data = userDoc.data();
      // Ensure all properties are defined, else set default values
      return {
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
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
    await ctx.replyWithMarkdown(`✅ Success! Your new wallet has been generated on **${chain}**:\n\n\`${walletAddress}\`\n\n**Supported Assets (testnet only):** ${chains[chain].supportedAssets.join(', ')}`, getMainMenu(true, false));

    // **Automatically initiate bank linking for the newly created wallet**
    const newWalletIndex = userState.wallets.length - 1; // Index of the newly added wallet
    ctx.session.walletIndex = newWalletIndex;
    ctx.session.processType = 'linking'; // Indicate that this is a linking process

    // **Enter the bank linking scene automatically**
    await ctx.scene.enter('bank_linking_scene');

    // Delete the Generating Message
    await ctx.deleteMessage(generatingMessage.message_id);

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
🔢 *Account Number:* ${wallet.bank.accountNumber}
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

// Handle "📤 Send Payment Request" Button
bot.hears(/📤\s*Send Payment Request/i, async (ctx) => {
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

  // Check if a payment request process is already in progress
  if (ctx.session.isPaymentRequesting) {
    return await ctx.replyWithMarkdown('⚠️ You are already in the process of sending a payment request. Please complete the ongoing process before initiating a new one.');
  }

  // Initiate the payment request scene
  await ctx.scene.enter('payment_request_scene');
});

// Payment Request Scene Entry
paymentRequestScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    await ctx.replyWithMarkdown('⚠️ You have no wallets linked. Please generate a wallet first.', getMainMenu(false, false));
    return ctx.scene.leave();
  }

  // Set the flag to indicate payment request process is active
  ctx.session.isPaymentRequesting = true;
  ctx.session.paymentRequest = {}; // Initialize payment request data

  // Prompt user to enter the recipient's Telegram username
  await ctx.replyWithMarkdown('📤 *Send Payment Request*\n\nPlease enter the *Telegram username* of the person you want to send the invoice to (without @):');
});

// Payment Request Scene Message Handler
paymentRequestScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Check which step the user is in
  if (!ctx.session.paymentRequest.step) {
    // Step 1: Enter Recipient Username
    const inputUsername = ctx.message.text.trim().replace('@', '');
    if (!inputUsername) {
      return await ctx.replyWithMarkdown('❌ Username cannot be empty. Please enter a valid Telegram username (without @):');
    }

    // Attempt to fetch recipient's chat info
    try {
      const recipient = await bot.telegram.getChat(`@${inputUsername}`);
      const recipientId = recipient.id.toString();
      const recipientName = `${recipient.first_name} ${recipient.last_name || ''}`.trim();
      const recipientUsername = recipient.username || 'N/A';

      // Check if recipient exists in Firestore (has started the bot)
      const recipientDoc = await db.collection('users').doc(recipientId).get();
      if (!recipientDoc.exists) {
        await ctx.replyWithMarkdown(
          `⚠️ *User @${inputUsername} hasn't started the DirectPay bot yet.*\n` +
          `Please ask them to start the bot by clicking [here](https://t.me/YourBotUsername?start=invite_${userId}).`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        ctx.session.isPaymentRequesting = false;
        return ctx.scene.leave();
      }

      // Store recipient details
      ctx.session.paymentRequest.recipientId = recipientId;
      ctx.session.paymentRequest.recipientName = recipientName;
      ctx.session.paymentRequest.recipientUsername = recipientUsername;
      ctx.session.paymentRequest.step = 2;

      // Ask for the amount to request
      await ctx.replyWithMarkdown(
        `🔄 *Recipient Selected:*\n\n*Name:* ${recipientName}\n*Username:* @${recipientUsername}\n\nPlease enter the amount you wish to request in NGN:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Change Recipient', 'change_recipient')],
          [Markup.button.callback('❌ Cancel Payment Request', 'cancel_payment_request')],
        ])
      );
    } catch (error) {
      logger.error(`Error fetching user info for username @${inputUsername}: ${error.message}`);

      if (error.code === 403) {
        // Bot was blocked by the user or user hasn't started the bot
        await ctx.replyWithMarkdown(
          `⚠️ *Unable to find user @${inputUsername}.*\n` +
          `They might have blocked the bot or haven't started it.\n` +
          `Please ensure they have started the DirectPay bot before sending a payment request.`
        );
      } else if (error.code === 404) {
        // User not found
        await ctx.replyWithMarkdown(
          `❌ *User @${inputUsername} not found.*\n` +
          `Please check the username and try again.`
        );
      } else {
        // Other errors
        await ctx.replyWithMarkdown('⚠️ An unexpected error occurred. Please try again later.');
      }

      ctx.session.isPaymentRequesting = false;
      return ctx.scene.leave();
    }
  } else if (ctx.session.paymentRequest.step === 2) {
    // Step 2: Enter Amount
    const amountInput = ctx.message.text.trim();
    const amount = parseFloat(amountInput);

    if (isNaN(amount) || amount <= 0) {
      return await ctx.replyWithMarkdown('❌ Invalid amount. Please enter a positive number for the amount in NGN:');
    }

    ctx.session.paymentRequest.amount = amount;
    ctx.session.paymentRequest.step = 3;

    // Display confirmation summary
    await ctx.replyWithMarkdown(
      `📄 *Payment Request Summary:*\n\n` +
      `*Recipient:* ${ctx.session.paymentRequest.recipientName} (@${ctx.session.paymentRequest.recipientUsername})\n` +
      `*Amount:* ₦${amount.toFixed(2)}\n\n` +
      `Do you want to confirm this payment request?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', 'confirm_payment_request')],
        [Markup.button.callback('❌ Cancel', 'cancel_payment_request')],
      ])
    );
  }
});

// Change Recipient
paymentRequestScene.action('change_recipient', async (ctx) => {
  await ctx.replyWithMarkdown('🔄 *Change Recipient*\n\nPlease enter the new Telegram username of the person you want to send the invoice to (without @):');
  ctx.session.paymentRequest.step = 1;
  ctx.answerCbQuery();
});

// Confirm Payment Request
paymentRequestScene.action('confirm_payment_request', async (ctx) => {
  const userId = ctx.from.id.toString();
  const paymentRequest = ctx.session.paymentRequest;

  // Generate a unique reference ID
  const referenceId = generateReferenceId();
  paymentRequest.referenceId = referenceId;
  paymentRequest.status = 'Awaiting Deposit'; // Initial status

  // Store the payment request in Firestore
  try {
    await db.collection('paymentRequests').add({
      requesterId: userId,
      requesterName: ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : ''),
      recipientId: paymentRequest.recipientId,
      recipientUsername: paymentRequest.recipientUsername,
      amount: paymentRequest.amount,
      status: paymentRequest.status,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      referenceId: referenceId,
    });
  } catch (error) {
    logger.error(`Error storing payment request for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Failed to create payment request. Please try again later.');
    ctx.session.isPaymentRequesting = false;
    return ctx.scene.leave();
  }

  // Notify the recipient
  try {
    await bot.telegram.sendMessage(paymentRequest.recipientId,
      `📄 *Payment Request Received*\n\n` +
      `*From:* ${paymentRequest.requesterName} (@${ctx.from.username || 'N/A'})\n` +
      `*Amount:* ₦${paymentRequest.amount.toFixed(2)}\n` +
      `*Reference ID:* ${referenceId}\n\n` +
      `Please confirm if you have sent the payment.`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm Payment Sent', `confirm_payment_${referenceId}`)],
          [Markup.button.callback('❌ Cancel Payment Request', 'cancel_payment_request')],
        ]),
      }
    );

    // Notify admin about the new payment request
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `📄 *New Payment Request*\n\n` +
      `*Reference ID:* ${referenceId}\n` +
      `*Requester:* ${paymentRequest.requesterName} (@${ctx.from.username || 'N/A'})\n` +
      `*Recipient:* @${paymentRequest.recipientUsername || 'N/A'}\n` +
      `*Amount:* ₦${paymentRequest.amount.toFixed(2)}\n` +
      `*Timestamp:* ${new Date().toLocaleString()}`,
      { parse_mode: 'Markdown' }
    );

    await ctx.replyWithMarkdown('📄 *Payment Request Sent Successfully!*', getMainMenu(true, true));
    logger.info(`User ${userId} requested ₦${paymentRequest.amount} from user ${paymentRequest.recipientId} with Reference ID ${referenceId}`);
  } catch (error) {
    logger.error(`Error notifying recipient ${paymentRequest.recipientId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Failed to notify the recipient. They might have blocked the bot or haven\'t started it yet.');
    ctx.session.isPaymentRequesting = false;
    return ctx.scene.leave();
  }

  // Clear the session and exit the scene
  ctx.session.isPaymentRequesting = false;
  delete ctx.session.paymentRequest;
  ctx.scene.leave();
  ctx.answerCbQuery();
});

// Cancel Payment Request
paymentRequestScene.action('cancel_payment_request', async (ctx) => {
  await ctx.replyWithMarkdown('❌ *Payment Request Canceled.*');
  ctx.session.isPaymentRequesting = false;
  delete ctx.session.paymentRequest;
  ctx.scene.leave();
  ctx.answerCbQuery();
});
// Handle Recipient's Confirmation of Payment Sent
bot.action(/confirm_payment_(.+)/, async (ctx) => {
  const referenceId = ctx.match[1];
  const recipientId = ctx.from.id.toString();

  // Update the payment request status in Firestore
  try {
    const paymentRequests = await db.collection('paymentRequests')
      .where('referenceId', '==', referenceId)
      .where('recipientId', '==', recipientId)
      .get();

    if (paymentRequests.empty) {
      await ctx.replyWithMarkdown('⚠️ Payment request not found or already confirmed.');
      return ctx.answerCbQuery();
    }

    const paymentRequestDoc = paymentRequests.docs[0];
    const paymentRequestData = paymentRequestDoc.data();

    // Update the status
    await paymentRequestDoc.ref.update({ status: 'Payment Sent' });

    // Notify the requester
    await bot.telegram.sendMessage(paymentRequestData.requesterId,
      `✅ *Payment Sent Confirmation*\n\n` +
      `*Recipient:* @${paymentRequestData.recipientUsername}\n` +
      `*Amount:* ₦${paymentRequestData.amount.toFixed(2)}\n` +
      `*Reference ID:* ${referenceId}\n\n` +
      `The recipient has confirmed that the payment has been sent.`,
      { parse_mode: 'Markdown' }
    );

    // Notify the recipient
    await ctx.replyWithMarkdown('✅ *You have confirmed that the payment has been sent.*');

    // Notify admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID,
      `✅ *Payment Sent Confirmation*\n\n` +
      `*Reference ID:* ${referenceId}\n` +
      `*Requester:* @${paymentRequestData.requesterUsername}\n` +
      `*Recipient:* @${paymentRequestData.recipientUsername}\n` +
      `*Amount:* ₦${paymentRequestData.amount.toFixed(2)}\n` +
      `*Timestamp:* ${new Date().toLocaleString()}`,
      { parse_mode: 'Markdown' }
    );

    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error confirming payment for reference ID ${referenceId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while confirming the payment. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Payment Request Scene Leave Handler
paymentRequestScene.leave((ctx) => {
  ctx.session.isPaymentRequesting = false;
  delete ctx.session.paymentRequest;
});

// Handler for "Create New Wallet" Button
bot.action('create_new_wallet', async (ctx) => {
  // Check if a bank linking process is already in progress
  if (ctx.session.isBankLinking) {
    await ctx.replyWithMarkdown('⚠️ You are currently linking a bank account. Please complete that process before creating a new wallet.');
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

// Link Bank Account Handler
bot.hears(/🏦\s*Link Bank Account/i, async (ctx) => {
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

  // Check if a bank linking process is already in progress
  if (ctx.session.isBankLinking) {
    return await ctx.replyWithMarkdown('⚠️ You are already in the process of linking a bank account. Please complete the ongoing process before initiating a new one.');
  }

  // **Initiate the bank linking scene**
  ctx.session.processType = 'linking';
  await ctx.scene.enter('bank_linking_scene');
});

// Edit Bank Account Option Handler
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
    return await ctx.replyWithMarkdown('❌ You have no wallets linked.', getMainMenu(true, false));
  }

  // Check if a bank linking process is already in progress
  if (ctx.session.isBankLinking) {
    return await ctx.replyWithMarkdown('⚠️ You are already in the process of linking a bank account. Please complete the ongoing process before initiating a new one.');
  }

  // **Initiate the edit bank linking scene**
  ctx.session.processType = 'editing'; // Indicate that this is an editing process
  await ctx.scene.enter('bank_linking_scene');
});

// Handle Selecting Wallets for Editing or Linking Bank Accounts
bankLinkingScene.enter(async (ctx) => {
  // Check if a bank linking process is already in progress
  if (ctx.session.isBankLinking) {
    await ctx.replyWithMarkdown('⚠️ You are already in the process of linking a bank account. Please complete the ongoing process before initiating a new one.');
    return ctx.scene.leave();
  }

  // Set the bank linking flag to true
  ctx.session.isBankLinking = true;

  ctx.session.bankData = {};
  ctx.session.processType = ctx.session.processType || 'linking'; // 'linking' or 'editing'
  // ctx.session.walletIndex should already be set for auto-initiated linking
  logger.info(`Entering bankLinkingScene for user ${ctx.from.id}. Process Type: ${ctx.session.processType}. Wallet Index: ${ctx.session.walletIndex}`);

  if (ctx.session.processType === 'linking' && ctx.session.walletIndex !== null && ctx.session.walletIndex !== undefined) {
    // **Auto-initiated linking for a specific wallet**
    await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');

    // Start the timeout for inactivity
    ctx.session.bankLinkingTimeout = setTimeout(() => {
      if (ctx.session.isBankLinking) {
        ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        ctx.scene.leave();
      }
    }, 300000); // 5 minutes timeout
  } else if (ctx.session.processType === 'editing') {
    // **Editing bank account details for existing linked wallets or linking to unlinked wallets**

    let userState;
    try {
      userState = await getUserState(ctx.from.id.toString());
    } catch (error) {
      logger.error(`Error fetching user state for ${ctx.from.id}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
      return;
    }

    const linkedWallets = userState.wallets
      .map((wallet, index) => ({ wallet, index }))
      .filter(item => item.wallet.bank);

    const unlinkedWallets = userState.wallets
      .map((wallet, index) => ({ wallet, index }))
      .filter(item => !item.wallet.bank);

    const hasLinked = linkedWallets.length > 0;
    const hasUnlinked = unlinkedWallets.length > 0;

    if (!hasLinked && !hasUnlinked) {
      await ctx.replyWithMarkdown('✅ All your wallets have linked bank accounts.');
      ctx.scene.leave();
      return;
    }

    // Present Options Based on Available Wallets
    const options = [];
    if (hasLinked) {
      options.push(Markup.button.callback('✏️ Edit Existing Bank Accounts', 'edit_existing_banks'));
    }
    if (hasUnlinked) {
      options.push(Markup.button.callback('➕ Link Bank to Unlinked Wallets', 'link_unlinked_wallets'));
    }
    options.push(Markup.button.callback('🔙 Back to Main Menu', 'exit_bank_linking'));

    await ctx.replyWithMarkdown('🔧 *Edit Bank Account Options*:', Markup.inlineKeyboard(options, { columns: 1 }));
  } else {
    // **User-initiated linking; prompt to select which wallet to link**
    let userState;
    try {
      userState = await getUserState(ctx.from.id.toString());
    } catch (error) {
      logger.error(`Error fetching user state for ${ctx.from.id}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
      return;
    }

    const walletsPendingLink = userState.wallets
      .map((wallet, index) => ({ wallet, index }))
      .filter(item => !item.wallet.bank);

    if (walletsPendingLink.length === 0) {
      await ctx.replyWithMarkdown('✅ All your wallets have linked bank accounts.');
      ctx.scene.leave();
      return;
    }

    if (walletsPendingLink.length === 1) {
      // **Only one wallet pending linking; set walletIndex automatically**
      ctx.session.walletIndex = walletsPendingLink[0].index;
      await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');

      // Start the timeout for inactivity
      ctx.session.bankLinkingTimeout = setTimeout(() => {
        if (ctx.session.isBankLinking) {
          ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
          ctx.scene.leave();
        }
      }, 300000); // 5 minutes timeout
    } else {
      // **Multiple wallets pending linking; prompt user to select**
      let selectionMessage = '💼 *Select a Wallet to Link a Bank Account*:\n\n';
      walletsPendingLink.forEach((item) => {
        const { wallet, index } = item;
        selectionMessage += `*Wallet ${index + 1}:* ${wallet.address.slice(0, 3)}...${wallet.address.slice(-4)}\n`;
      });

      await ctx.replyWithMarkdown(selectionMessage, Markup.inlineKeyboard(
        walletsPendingLink.map(item => [Markup.button.callback(`Wallet ${item.index + 1}`, `select_wallet_${item.index}`)])
      ));
    }
  }
});

// Handler for Selecting a Wallet to Link Bank Account
bankLinkingScene.action(/select_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = walletIndex;
  await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');
  ctx.answerCbQuery(); // Acknowledge the callback

  // Clear any existing timeout and start a new one
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout
});

// Handle Text Inputs in Bank Linking Scene
bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.trim();

  // Clear the inactivity timeout upon receiving input
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }

  if (!ctx.session.bankData.step) {
    // Step 1: Process Bank Name
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:');
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');

    // Restart the inactivity timeout
    ctx.session.bankLinkingTimeout = setTimeout(() => {
      if (ctx.session.isBankLinking) {
        ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        ctx.scene.leave();
      }
    }, 300000); // 5 minutes timeout
  } else if (ctx.session.bankData.step === 2) {
    // Step 2: Process Account Number
    if (!/^\d{10}$/.test(input)) {
      return await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    // Verify Bank Account
    await ctx.replyWithMarkdown('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(ctx.session.bankData.accountNumber, ctx.session.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;

      if (!accountName) {
        throw new Error('Unable to retrieve account name.');
      }

      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;

      // Ask for Confirmation
      await ctx.replyWithMarkdown(`🏦 *Bank Account Verification*\n\n` +
        `Please confirm your bank details:\n` +
        `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
        `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
        `- *Account Holder:* ${accountName}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
          [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')], // New cancellation option
        ])
      );

      // Restart the inactivity timeout
      ctx.session.bankLinkingTimeout = setTimeout(() => {
        if (ctx.session.isBankLinking) {
          ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
          ctx.scene.leave();
        }
      }, 300000); // 5 minutes timeout
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      ctx.scene.leave();
    }
  }
});

// Confirm Bank Account
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  logger.info(`User ${userId} confirmed bank linking/editing. Wallet Index: ${walletIndex}`);

  try {
    let userState = await getUserState(userId);

    if (ctx.session.processType === 'editing') {
      // Editing Bank Account Details or Linking to Unlinked Wallets
      if (ctx.session.walletIndex !== undefined && ctx.session.walletIndex !== null) {
        // Editing existing bank account
        if (!userState.wallets[walletIndex] || !userState.wallets[walletIndex].bank) {
          await ctx.replyWithMarkdown('⚠️ No linked bank account found for the selected wallet. Please try again.', getMainMenu(true, false));
          ctx.scene.leave();
          return;
        }

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
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} edited a bank account:\n\n` +
          `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n` +
          `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
          `*Account Number:* ${userState.wallets[walletIndex].bank.accountNumber}`, { parse_mode: 'Markdown' });
        logger.info(`User ${userId} edited a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);
      } else {
        // Linking to Unlinked Wallets (This should not occur as walletIndex should be set)
        await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please try again.', getMainMenu(true, false));
        ctx.scene.leave();
        return;
      }
    } else {
      // Linking Process
      if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
        await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please try again.', getMainMenu(true, false));
        ctx.scene.leave();
        return;
      }

      // Retrieve the selected wallet
      const selectedWallet = userState.wallets[walletIndex];

      // Update Bank Details for the Selected Wallet
      selectedWallet.bank = {
        bankName: bankData.bankName,
        bankCode: bankData.bankCode,
        accountNumber: bankData.accountNumber,
        accountName: bankData.accountName,
      };

      // Update User State in Firestore
      await updateUserState(userId, {
        wallets: userState.wallets,
      });

      // Prepare Rates Message with Wallet Address and Supported Tokens
      let ratesMessage = `✅ *Your bank account has been updated successfully!*\n\n`;
      ratesMessage += `*Wallet Address:* \`${selectedWallet.address}\`\n`;
      ratesMessage += `*Supported Tokens:* ${selectedWallet.supportedAssets.join(', ')}\n\n`;
      ratesMessage += `*Current Exchange Rates:*\n`;
      ratesMessage += `- *USDC:* ₦${selectedWallet.supportedAssets.includes('USDC') ? 'Fetching...' : 'N/A'} per USDC\n`;
      ratesMessage += `- *USDT:* ₦${selectedWallet.supportedAssets.includes('USDT') ? 'Fetching...' : 'N/A'} per USDT\n`;
      ratesMessage += `- *ETH:* ₦${selectedWallet.supportedAssets.includes('ETH') ? 'Fetching...' : 'N/A'} per ETH\n\n`;
      ratesMessage += `*Note:* These rates are updated every 5 minutes for accuracy.`;

      // Fetch dynamic rates for display
      try {
        const dynamicRates = await fetchDynamicRates();
        let dynamicRatesMessage = `📈 *Current Exchange Rates:*\n\n`;
        for (const [asset, rate] of Object.entries(dynamicRates)) {
          dynamicRatesMessage += `- *${asset}:* ₦${rate} per ${asset}\n`;
        }
        dynamicRatesMessage += `\n*Note:* These rates are fetched in real-time for accuracy.`;

        ratesMessage = `✅ *Your bank account has been updated successfully!*\n\n` +
          `*Wallet Address:* \`${selectedWallet.address}\`\n` +
          `*Supported Tokens:* ${selectedWallet.supportedAssets.join(', ')}\n\n` +
          `*Current Exchange Rates:*\n${dynamicRatesMessage}`;
      } catch (error) {
        ratesMessage += `\n⚠️ Unable to fetch dynamic exchange rates. Please try again later.`;
      }

      await ctx.replyWithMarkdown(ratesMessage, getMainMenu(true, true));

      // Log to Admin
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} updated a bank account:\n\n` +
        `*Account Name:* ${selectedWallet.bank.accountName}\n` +
        `*Bank Name:* ${selectedWallet.bank.bankName}\n` +
        `*Account Number:* ${selectedWallet.bank.accountNumber}`, { parse_mode: 'Markdown' });
      logger.info(`User ${userId} updated a bank account: ${JSON.stringify(selectedWallet.bank)}`);

      // Note: If you store 'payout' during initial deposit, no need to store here. If not, adjust accordingly.
    }

    // Store Transaction in Firestore (if applicable)
    // (Assuming transactions are only stored upon deposit, not during bank linking)

// Handle Editing Existing Bank Accounts
bankLinkingScene.action('edit_existing_banks', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    ctx.scene.leave();
    return;
  }

  const linkedWallets = userState.wallets
    .map((wallet, index) => ({ wallet, index }))
    .filter(item => item.wallet.bank);

  if (linkedWallets.length === 0) {
    await ctx.replyWithMarkdown('❌ You have no linked bank accounts to edit.');
    ctx.scene.leave();
    return;
  }

  // Prompt User to Select a Wallet to Edit
  let selectionMessage = '✏️ *Select a Wallet to Edit Its Bank Account*:\n\n';
  linkedWallets.forEach((item) => {
    const { wallet, index } = item;
    selectionMessage += `*Wallet ${index + 1}:* ${wallet.address.slice(0, 3)}...${wallet.address.slice(-4)}\n`;
  });

  await ctx.replyWithMarkdown(selectionMessage, Markup.inlineKeyboard(
    linkedWallets.map(item => [Markup.button.callback(`Wallet ${item.index + 1}`, `edit_existing_wallet_${item.index}`)])
  ));
});

// Handler for Selecting a Wallet to Edit Existing Bank Account
bankLinkingScene.action(/edit_existing_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = walletIndex;
  await ctx.replyWithMarkdown('🏦 Please enter your new bank name (e.g., Access Bank):');
  ctx.answerCbQuery(); // Acknowledge the callback

  // Clear any existing timeout and start a new one
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout
});

// Handle Bank Linking Cancellation
bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  // Clean Up Session Variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  delete ctx.session.isBankLinking; // Ensure flag is reset

  // Clear the inactivity timeout
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
    delete ctx.session.bankLinkingTimeout;
  }

  ctx.scene.leave();
});

// Send Message Scene (Handles Text and Images)
sendMessageScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('📩 Please enter the User ID you want to message:');
});

sendMessageScene.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (!ctx.session.sendMessageStep) {
    // Step 1: Capture User ID
    const userIdToMessage = ctx.message.text.trim();

    // Validate User ID (should be numeric and reasonable length, e.g., Telegram IDs are typically between 5 to 15 digits)
    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      return await ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
    }

    // Optionally, verify if the User ID exists in your database
    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      return await ctx.replyWithMarkdown('❌ User ID not found. Please ensure the User ID is correct or try another one:');
    }

    // Proceed to Step 2
    ctx.session.sendMessageStep = 2;
    ctx.session.userIdToMessage = userIdToMessage;
    await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message.');
  } else if (ctx.session.sendMessageStep === 2) {
    // Step 2: Capture Message Content
    const userIdToMessage = ctx.session.userIdToMessage;

    if (ctx.message.photo) {
      // Message contains a photo
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1]; // Get the highest resolution photo
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      try {
        // Send the photo with caption to the target user
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Photo message sent successfully.');
        logger.info(`Admin ${userId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else if (ctx.message.text) {
      // Message contains only text
      const messageContent = ctx.message.text.trim();

      if (!messageContent) {
        return await ctx.replyWithMarkdown('❌ Message content cannot be empty. Please enter a valid message:');
      }

      try {
        // Send the text message to the target user
        await bot.telegram.sendMessage(userIdToMessage, `**📩 Message from Admin:**\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Text message sent successfully.');
        logger.info(`Admin ${userId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else {
      // Unsupported message type
      await ctx.replyWithMarkdown('❌ Unsupported message type. Please send text or a photo (receipt).');
      return;
    }

    // Reset Session Variables and Leave the Scene
    delete ctx.session.userIdToMessage;
    delete ctx.session.sendMessageStep;
    ctx.scene.leave();
  }
});

// Handle Unsupported Message Types in SendMessageScene
sendMessageScene.on('message', async (ctx) => {
  if (ctx.session.sendMessageStep !== undefined) {
    await ctx.replyWithMarkdown('❌ Please send text messages or photos only.');
  }
});

// Handle Scene Exit
sendMessageScene.leave((ctx) => {
  delete ctx.session.userIdToMessage;
  delete ctx.session.sendMessageStep;
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
Visit the support section or contact our support team at [@maxcswap](https://t.me/maxcswap) for any assistance.
`,
  transaction_guide: `
**💰 Transaction Not Received?**

If you haven't received your transaction, follow these steps to troubleshoot:

1. **Verify Wallet Address:**
   - Ensure that the sender used the correct wallet address provided by DirectPay.

2. **Check Bank Linking:**
   - Make sure your bank account is correctly linked.
   - If not linked, go to "🏦 Link Bank Account" to add your bank details.

3. **Monitor Transaction Status:**
   - Use the "💰 Transactions" section to check the status of your deposit.
   - Pending status indicates that the deposit is being processed.

4. **Wait for Confirmation:**
   - Deposits might take a few minutes to reflect depending on the network congestion.

5. **Contact Support:**
   - If the issue persists after following the above steps, reach out to our support team at [@maxswap](https://t.me/maxcswap) with your transaction details for further assistance.
`,
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

// Learn About Base with Pagination and Inline Updates
const baseContent = [
  {
    title: '📘 How DirectPay Works - Page 1/3',
    text: `**Welcome to DirectPay!**

DirectPay is your gateway to seamless crypto transactions. Here's how it works:

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.
`,
  },
  {
    title: '📘 How DirectPay Works - Page 2/3',
    text: `**📡 Link Your Bank Account**

2. **Link Your Bank Account:**
   - Go to "🏦 Link Bank Account."
   - Provide your bank details to securely receive payouts directly into your bank account.

3. **Receive Payments:**
   - Share your wallet address with clients or payment sources.
   - Once a deposit is made, DirectPay will automatically convert the crypto to NGN at current exchange rates.
`,
  },
  {
    title: '📘 How DirectPay Works - Page 3/3',
    text: `**📊 Monitor Transactions & Support**

4. **Monitor Transactions:**
   - Use the "💰 Transactions" option to view all your deposit and payout activities.

5. **Support & Assistance:**
   - Access detailed support tutorials anytime from the "ℹ️ Support" section.

**🔒 Security:**
Your funds are secure with us. We utilize industry-standard encryption and security protocols to ensure your assets and information remain safe.

**💬 Need Help?**
Visit the support section or contact our support team at [@maxcswap](https://t.me/maxcswap) for any assistance.
`,
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
  await ctx.replyWithMarkdown('Thank you for learning about DirectPay!');
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

// View Transactions for Users
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .get();

    if (transactionsSnapshot.empty) {
      return await ctx.replyWithMarkdown('You have no transactions at the moment.');
    }

    let message = '💰 *Your Transactions*:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `*Transaction Hash:* \`${tx.transactionHash || 'N/A'}\`\n`;
      message += `*Amount Received:* ${tx.amountReceived ? tx.amountReceived.toFixed(2) : 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `*Amount Paid:* ${tx.amountPaid ? tx.amountPaid.toFixed(2) : 'N/A'} NGN\n`;
      message += `*Bank Paid To:* ${tx.bankPaidTo || 'N/A'}\n`;
      message += `*Company:* ${tx.companyName || 'N/A'}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
    logger.info(`User ${userId} viewed their transactions.`);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Admin Functions

// Entry point for Admin Panel
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Reset session variables if necessary
  ctx.session.adminMessageId = null;

  const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;
  ctx.answerCbQuery(); // Acknowledge the callback

  // Set a timeout to delete the admin panel message after 5 minutes
  setTimeout(() => {
    if (ctx.session.adminMessageId) {
      ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  }, 300000); // Delete after 5 minutes
});

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  switch (action) {
    case 'view_transactions':
      // Handle viewing transactions
      try {
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

        if (transactionsSnapshot.empty) {
          await ctx.answerCbQuery('No transactions found.', { show_alert: true });
          return;
        }

        let message = '📋 **Recent Transactions**:\n\n';

        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += `*User ID:* ${tx.userId || 'N/A'}\n`;
          message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
          message += `*Transaction Hash:* \`${tx.transactionHash || 'N/A'}\`\n`;
          message += `*Amount Received:* ${tx.amountReceived ? tx.amountReceived.toFixed(2) : 'N/A'} ${tx.asset || 'N/A'}\n`;
          message += `*Amount Paid:* ${tx.amountPaid ? tx.amountPaid.toFixed(2) : 'N/A'} NGN\n`;
          message += `*Bank Paid To:* ${tx.bankPaidTo || 'N/A'}\n`;
          message += `*Company:* ${tx.companyName || 'N/A'}\n`;
          message += `*Status:* ${tx.status || 'Pending'}\n`;
          message += `*Chain:* ${tx.chain || 'N/A'}\n`;
          message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
        });

        // Add a 'Back' button to return to the admin menu
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        // Edit the admin panel message
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all transactions: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });
      }
      break;

    case 'send_message':
      // Handle sending messages
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      await ctx.scene.enter('send_message_scene');
      ctx.answerCbQuery();
      break;

    case 'mark_paid':
      // Handle marking transactions as paid
      try {
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await ctx.answerCbQuery('No pending transactions found.', { show_alert: true });
          return;
        }

        const batch = db.batch();
        pendingTransactions.forEach((transaction) => {
          const docRef = db.collection('transactions').doc(transaction.id);
          batch.update(docRef, { status: 'Paid' });
        });

        await batch.commit();

        // Notify users about their transactions being marked as paid
        pendingTransactions.forEach(async (transaction) => {
          const data = transaction.data();
          try {
            // **Use Hardcoded Rates for Webhook Notifications**
            const payout = calculatePayout(data.asset, data.amount); // Using hardcoded rates

            // Safely Access accountName
            const accountName = data.bankDetails && data.bankDetails.accountName ? data.bankDetails.accountName : 'Valued User';

            await bot.telegram.sendMessage(
              data.userId,
              `🎉 *Transaction Successful!*\n\n` +
              `*Reference ID:* \`${data.referenceId || 'N/A'}\`\n` +
              `*Transaction Hash:* \`${data.transactionHash || 'N/A'}\`\n` +
              `*Amount Received:* ${data.amountReceived ? data.amountReceived.toFixed(2) : 'N/A'} ${data.asset || 'N/A'}\n` +
              `*Amount Paid:* ${data.amountPaid ? data.amountPaid.toFixed(2) : 'N/A'} NGN\n` +
              `*Bank Paid To:* ${data.bankPaidTo || 'N/A'}\n` +
              `*Company:* ${data.companyName || 'N/A'}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${data.chain}\n` +
              `*Date:* ${new Date(data.timestamp).toLocaleString()}\n\n` +
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
              { parse_mode: 'Markdown' }
            );
            logger.info(`Notified user ${data.userId} about paid transaction ${data.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${data.userId}: ${error.message}`);
          }
        });

        // Edit the admin panel message to confirm
        await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error marking transactions as paid: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
      }
      break;

    case 'view_users':
      // Handle viewing all users
      try {
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
          await ctx.answerCbQuery('No users found.', { show_alert: true });
          return;
        }

        let message = '👥 **All Users**:\n\n';

        usersSnapshot.forEach((doc) => {
          const user = doc.data();
          message += `*User ID:* ${doc.id}\n`;
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
        await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });
      }
      break;

    case 'broadcast_message':
      // Handle broadcasting messages
      await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
      // Set state to indicate awaiting broadcast message
      await updateUserState(userId, { awaitingBroadcastMessage: true });
      // Delete the admin panel message to keep chat clean
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;

    case 'manage_banks':
      // Implement bank management functionalities here
      await ctx.replyWithMarkdown('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      ctx.answerCbQuery();
      break;

    case 'admin_back_to_main':
      // Return to the main menu
      await greetUser(ctx);
      // Delete the admin panel message
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// Handle Broadcast Message Input
bot.on('message', async (ctx, next) => {
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
    const message = ctx.message;

    if (message.photo) {
      // Broadcast with Photo
      const photoArray = message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1]; // Get the highest resolution photo
      const fileId = highestResolutionPhoto.file_id;
      const caption = message.caption || '';

      let successCount = 0;
      let failureCount = 0;

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await bot.telegram.sendPhoto(targetUserId, fileId, { caption: caption, parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast photo to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted photo message. Success: ${successCount}, Failed: ${failureCount}`);
    } else if (message.text) {
      // Broadcast with Text
      const broadcastMessage = message.text.trim();
      if (!broadcastMessage) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      let successCount = 0;
      let failureCount = 0;

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await bot.telegram.sendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${broadcastMessage}`, { parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast message to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);
    } else {
      // Unsupported message type
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt) only.', getAdminMenu());
    }

    // Reset broadcast message state
    await updateUserState(userId, { awaitingBroadcastMessage: false });
  }

  await next(); // Pass control to the next handler
});

// Function to Send "How It Works" Pages
async function sendHowItWorksPage(ctx, pageIndex) {
  const page = howItWorksPages[pageIndex];
  const totalPages = howItWorksPages.length;

  const buttons = [];

  if (pageIndex > 0) {
    buttons.push(Markup.button.callback('⬅️ Back', `how_it_works_back_${pageIndex - 1}`));
  }

  if (pageIndex < totalPages - 1) {
    buttons.push(Markup.button.callback('Next ➡️', `how_it_works_next_${pageIndex + 1}`));
  }

  buttons.push(Markup.button.callback('🔚 Exit', 'how_it_works_exit'));

  const inlineKeyboard = Markup.inlineKeyboard([buttons]);

  if (pageIndex === 0) {
    // Send the first page
    const sentMessage = await ctx.replyWithMarkdown(`**${page.title}**\n\n${page.text}`, inlineKeyboard);
    // Store the message ID in session
    ctx.session.howItWorksMessageId = sentMessage.message_id;
  } else {
    try {
      // Edit the existing message to show the new page
      await ctx.editMessageText(`**${page.title}**\n\n${page.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdown(`**${page.title}**\n\n${page.text}`, inlineKeyboard);
      ctx.session.howItWorksMessageId = sentMessage.message_id;
    }
  }

  // Optionally, set a timeout to delete the message after 2 minutes
  setTimeout(() => {
    if (ctx.session.howItWorksMessageId) {
      ctx.deleteMessage(ctx.session.howItWorksMessageId).catch(() => {});
      ctx.session.howItWorksMessageId = null;
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
  await ctx.replyWithMarkdown('Thank you for learning about DirectPay!');
  ctx.answerCbQuery();
});

// Handle Base Content Pagination Buttons
bot.action(/how_it_works_back_(\d+)/, async (ctx) => {
  const previousPage = parseInt(ctx.match[1], 10);
  await sendHowItWorksPage(ctx, previousPage);
  ctx.answerCbQuery();
});

bot.action(/how_it_works_next_(\d+)/, async (ctx) => {
  const nextPage = parseInt(ctx.match[1], 10);
  await sendHowItWorksPage(ctx, nextPage);
  ctx.answerCbQuery();
});

// Handler for Exiting the Tutorial
bot.action('how_it_works_exit', async (ctx) => {
  if (ctx.session.howItWorksMessageId) {
    await ctx.deleteMessage(ctx.session.howItWorksMessageId).catch(() => {});
    ctx.session.howItWorksMessageId = null;
  }
  await ctx.replyWithMarkdown('You have exited the "How It Works" tutorial.');
  ctx.answerCbQuery();
});

// Support Functionality with Paginated "How It Works" Section
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('How can we assist you today?', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Handle Paginated "How It Works" Tutorial
bot.action('support_how_it_works', async (ctx) => {
  await sendHowItWorksPage(ctx, 0);
  ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
});

// Handle Navigation Buttons for "How It Works" Tutorial
bot.action(/how_it_works_back_(\d+)/, async (ctx) => {
  const previousPage = parseInt(ctx.match[1], 10);
  await sendHowItWorksPage(ctx, previousPage);
  ctx.answerCbQuery();
});

bot.action(/how_it_works_next_(\d+)/, async (ctx) => {
  const nextPage = parseInt(ctx.match[1], 10);
  await sendHowItWorksPage(ctx, nextPage);
  ctx.answerCbQuery();
});

// Exit the "How It Works" Section
bot.action('how_it_works_exit', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.howItWorksMessageId) {
    await ctx.deleteMessage(ctx.session.howItWorksMessageId).catch(() => {});
    ctx.session.howItWorksMessageId = null;
  }
  await ctx.replyWithMarkdown('You have exited the "How It Works" tutorial.');
  ctx.answerCbQuery();
});

// Handle Broadcast Message Input
bot.on('message', async (ctx, next) => {
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
    const message = ctx.message;

    if (message.photo) {
      // Broadcast with Photo
      const photoArray = message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1]; // Get the highest resolution photo
      const fileId = highestResolutionPhoto.file_id;
      const caption = message.caption || '';

      let successCount = 0;
      let failureCount = 0;

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await bot.telegram.sendPhoto(targetUserId, fileId, { caption: caption, parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast photo to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted photo message. Success: ${successCount}, Failed: ${failureCount}`);
    } else if (message.text) {
      // Broadcast with Text
      const broadcastMessage = message.text.trim();
      if (!broadcastMessage) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      let successCount = 0;
      let failureCount = 0;

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await bot.telegram.sendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${broadcastMessage}`, { parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast message to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);
    } else {
      // Unsupported message type
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt) only.', getAdminMenu());
    }

    // Reset broadcast message state
    await updateUserState(userId, { awaitingBroadcastMessage: false });
  }

  await next(); // Pass control to the next handler
});

// Handle Broadcast Message Step (if needed)
bot.on('callback_query', async (ctx) => {
  // You can handle additional callback queries here if necessary
  ctx.answerCbQuery();
});


// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chain = event.data?.blockchain?.name || 'N/A';

    if (eventType === 'deposit.success') {
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // Find User by Wallet Address
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();

      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 Deposit Received: ${amount} ${asset} on ${chain}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
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
        `We are processing your transaction at a rate of *NGN ${(payout / amount).toFixed(2)}* per ${asset}.\n` +
        `You will receive *NGN ${payout}* in your ${bankName} account (${bankAccount}) shortly.\n\n` +
        `Thank you for using *DirectPay*. We appreciate your trust in our services.\n\n` +
        `*Note:* If you have any questions, feel free to reach out to our support team.`,
        { parse_mode: 'Markdown' }
      );

      // Notify Admin with Detailed Transaction Information
      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Exchange Rate:* NGN ${(payout / amount).toFixed(2)} per ${asset}\n` +
        `*Amount to be Paid:* NGN ${payout}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank Name:* ${bankName}\n` +
        `  - *Account Number:* ${bankAccount}\n` +
        `*Chain:* ${chain}\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` +
        `*Reference ID:* ${referenceId}\n`;

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      // Store Transaction in Firestore
      await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chain,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        payout: payout, // Ensure 'payout' is stored
        timestamp: new Date().toISOString(),
        status: 'Pending',
      });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${referenceId}`);

     
      const paymentRequestsSnapshot = await db.collection('paymentRequests')
        .where('recipientId', '==', userId)
        .where('status', '==', 'Awaiting Deposit')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (!paymentRequestsSnapshot.empty) {
        const paymentRequestDoc = paymentRequestsSnapshot.docs[0];
        const paymentRequestData = paymentRequestDoc.data();

       
        await paymentRequestDoc.ref.update({ status: 'Deposit Confirmed' });
        
        await bot.telegram.sendMessage(paymentRequestData.requesterId,
          `🎉 *Payment Received!*\n\n` +
          `*Recipient:* @${paymentRequestData.recipientUsername}\n` +
          `*Amount:* ₦${paymentRequestData.amount.toFixed(2)}\n` +
          `*Reference ID:* ${paymentRequestData.referenceId}\n\n` +
          `The deposit corresponding to your payment request has been confirmed.`,
          { parse_mode: 'Markdown' }
        );

        // **Notify the recipient**
        await bot.telegram.sendMessage(userId,
          `✅ *Deposit Confirmed*\n\n` +
          `Your deposit of *${amount} ${asset}* has been confirmed and linked to the payment request from *@${paymentRequestData.requesterUsername}*.\n\n` +
          `*Reference ID:* ${paymentRequestData.referenceId}\n` +
          `Thank you for using DirectPay!`,
          { parse_mode: 'Markdown' }
        );
      }

      return res.status(200).send('OK');
    } else {
      // Handle other event types if necessary
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `ℹ️ Unhandled event type: ${eventType}`);
      return res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing webhook: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
  }
});

// Telegram Webhook Setup

// Set Telegram webhook
(async () => {
  try {
    await bot.telegram.setWebhook(TELEGRAM_WEBHOOK_URL);
    logger.info(`Telegram webhook set to ${TELEGRAM_WEBHOOK_URL}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error.message}`);
    process.exit(1);
  }
})();

// Telegram Webhook Handler
app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
