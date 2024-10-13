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
// User states are stored in Firestore for persistence.
// The in-memory `userStates` object acts as a cache to reduce Firestore reads.
let userStates = {}; // In-memory cache of user states
const MAX_WALLETS = 3; // Max wallets per user

// Updated Bank List with Aliases
const bankList = [
  { name: '9mobile 9Payment Service Bank', code: '120001', aliases: ['9PSB', '9mobile PSB'] },
  { name: 'Abbey Mortgage Bank', code: '801', aliases: ['Abbey Mortgage'] },
  { name: 'Above Only MFB', code: '51204', aliases: ['Above Only Microfinance Bank'] },
  { name: 'Abulesoro MFB', code: '51312', aliases: ['Abulesoro Microfinance Bank'] },
  { name: 'Access Bank', code: '044', aliases: ['Access', 'Diamond Bank'] },
  { name: 'Access Bank (Diamond)', code: '063', aliases: ['Access Diamond', 'Diamond Bank'] },
  { name: 'Airtel Smartcash PSB', code: '120004', aliases: ['Smartcash', 'Airtel PSB'] },
  { name: 'ALAT by WEMA', code: '035A', aliases: ['ALAT', 'Wema ALAT'] },
  { name: 'Amju Unique MFB', code: '50926', aliases: ['Amju Unique Microfinance Bank'] },
  { name: 'Aramoko MFB', code: '50083', aliases: ['Aramoko Microfinance Bank'] },
  { name: 'ASO Savings and Loans', code: '401', aliases: ['ASO Savings'] },
  { name: 'Astrapolaris MFB LTD', code: 'MFB50094', aliases: ['Astrapolaris Microfinance Bank'] },
  { name: 'Bainescredit MFB', code: '51229', aliases: ['Bainescredit Microfinance Bank'] },
  { name: 'Bowen Microfinance Bank', code: '50931', aliases: ['Bowen MFB'] },
  { name: 'Carbon', code: '565', aliases: ['Paylater'] },
  { name: 'CEMCS Microfinance Bank', code: '50823', aliases: ['CEMCS MFB'] },
  { name: 'Chanelle Microfinance Bank Limited', code: '50171', aliases: ['Chanelle MFB'] },
  { name: 'Citibank Nigeria', code: '023', aliases: ['Citibank', 'Citi Bank'] },
  { name: 'Corestep MFB', code: '50204', aliases: ['Corestep Microfinance Bank'] },
  { name: 'Coronation Merchant Bank', code: '559', aliases: ['Coronation Bank'] },
  { name: 'Crescent MFB', code: '51297', aliases: ['Crescent Microfinance Bank'] },
  { name: 'Ecobank Nigeria', code: '050', aliases: ['Ecobank'] },
  { name: 'Ekimogun MFB', code: '50263', aliases: ['Ekimogun Microfinance Bank'] },
  { name: 'Ekondo Microfinance Bank', code: '562', aliases: ['Ekondo MFB'] },
  { name: 'Eyowo', code: '50126', aliases: ['Eyowo Microfinance Bank'] },
  { name: 'Fidelity Bank', code: '070', aliases: ['Fidelity'] },
  { name: 'Firmus MFB', code: '51314', aliases: ['Firmus Microfinance Bank'] },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['First Bank', 'FBN'] },
  { name: 'First City Monument Bank', code: '214', aliases: ['FCMB'] },
  { name: 'FSDH Merchant Bank Limited', code: '501', aliases: ['FSDH Bank'] },
  { name: 'Gateway Mortgage Bank LTD', code: '812', aliases: ['Gateway Mortgage Bank'] },
  { name: 'Globus Bank', code: '00103', aliases: ['Globus'] },
  { name: 'GoMoney', code: '100022', aliases: ['Go Money'] },
  { name: 'Guaranty Trust Bank', code: '058', aliases: ['GTBank', 'GTB', 'Guarantee Trust Bank'] },
  { name: 'Hackman Microfinance Bank', code: '51251', aliases: ['Hackman MFB'] },
  { name: 'Hasal Microfinance Bank', code: '50383', aliases: ['Hasal MFB'] },
  { name: 'Heritage Bank', code: '030', aliases: ['Heritage'] },
  { name: 'HopePSB', code: '120002', aliases: ['Hope PSB'] },
  { name: 'Ibile Microfinance Bank', code: '51244', aliases: ['Ibile MFB'] },
  { name: 'Ikoyi Osun MFB', code: '50439', aliases: ['Ikoyi Osun Microfinance Bank'] },
  { name: 'Infinity MFB', code: '50457', aliases: ['Infinity Microfinance Bank'] },
  { name: 'Jaiz Bank', code: '301', aliases: ['Jaiz'] },
  { name: 'Kadpoly MFB', code: '50502', aliases: ['Kadpoly Microfinance Bank'] },
  { name: 'Keystone Bank', code: '082', aliases: ['Keystone'] },
  { name: 'Kredi Money MFB LTD', code: '50200', aliases: ['Kredi Money'] },
  { name: 'Kuda Bank', code: '50211', aliases: ['Kuda'] },
  { name: 'Lagos Building Investment Company Plc.', code: '90052', aliases: ['LBIC'] },
  { name: 'Links MFB', code: '50549', aliases: ['Links Microfinance Bank'] },
  { name: 'Living Trust Mortgage Bank', code: '031', aliases: ['Living Trust Bank'] },
  { name: 'Lotus Bank', code: '303', aliases: ['Lotus'] },
  { name: 'Mayfair MFB', code: '50563', aliases: ['Mayfair Microfinance Bank'] },
  { name: 'Mint MFB', code: '50304', aliases: ['Mint Microfinance Bank'] },
  { name: 'MTN Momo PSB', code: '120003', aliases: ['Momo PSB', 'MTN PSB'] },
  { name: 'Paga', code: '100002', aliases: ['Pagatech', 'PagaPay'] },
  { name: 'PalmPay', code: '999991', aliases: ['Palm Pay'] },
  { name: 'Parallex Bank', code: '104', aliases: ['Parallex'] },
  { name: 'Parkway - ReadyCash', code: '311', aliases: ['ReadyCash', 'Parkway'] },
  { name: 'Paycom', code: '999992', aliases: ['OPay', 'Paycom'] },
  { name: 'Petra Mircofinance Bank Plc', code: '50746', aliases: ['Petra MFB'] },
  { name: 'Polaris Bank', code: '076', aliases: ['Polaris'] },
  { name: 'Polyunwana MFB', code: '50864', aliases: ['Polyunwana Microfinance Bank'] },
  { name: 'PremiumTrust Bank', code: '105', aliases: ['Premium Trust Bank'] },
  { name: 'Providus Bank', code: '101', aliases: ['Providus'] },
  { name: 'QuickFund MFB', code: '51293', aliases: ['QuickFund Microfinance Bank'] },
  { name: 'Rand Merchant Bank', code: '502', aliases: ['RMB'] },
  { name: 'Refuge Mortgage Bank', code: '90067', aliases: ['Refuge Mortgage'] },
  { name: 'Rubies MFB', code: '125', aliases: ['Rubies Bank'] },
  { name: 'Safe Haven MFB', code: '51113', aliases: ['Safe Haven Microfinance Bank'] },
  { name: 'Solid Rock MFB', code: '50800', aliases: ['Solid Rock Microfinance Bank'] },
  { name: 'Sparkle Microfinance Bank', code: '51310', aliases: ['Sparkle'] },
  { name: 'Stanbic IBTC Bank', code: '221', aliases: ['Stanbic', 'IBTC', 'Stanbic Bank'] },
  { name: 'Standard Chartered Bank', code: '068', aliases: ['Standard Chartered', 'StanChart'] },
  { name: 'Stellas MFB', code: '51253', aliases: ['Stellas Microfinance Bank'] },
  { name: 'Sterling Bank', code: '232', aliases: ['Sterling'] },
  { name: 'Suntrust Bank', code: '100', aliases: ['SunTrust'] },
  { name: 'TAJ Bank', code: '302', aliases: ['TAJ'] },
  { name: 'Tangerine Money', code: '51269', aliases: ['Tangerine'] },
  { name: 'TCF MFB', code: '51211', aliases: ['TCF Microfinance Bank'] },
  { name: 'Titan Bank', code: '102', aliases: ['Titan Trust Bank'] },
  { name: 'Titan Paystack', code: '100039', aliases: ['Paystack Bank'] },
  { name: 'Unical MFB', code: '50871', aliases: ['Unical Microfinance Bank'] },
  { name: 'Union Bank of Nigeria', code: '032', aliases: ['Union Bank'] },
  { name: 'United Bank For Africa', code: '033', aliases: ['UBA'] },
  { name: 'Unity Bank', code: '215', aliases: ['Unity'] },
  { name: 'VFD Microfinance Bank Limited', code: '566', aliases: ['VFD MFB', 'V Bank'] },
  { name: 'Wema Bank', code: '035', aliases: ['Wema'] },
  { name: 'Zenith Bank', code: '057', aliases: ['Zenith'] },
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

// Calculate payout based on asset type (after deposit.success)
function calculatePayout(asset, amount) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return (amount * rates[asset]).toFixed(2);
}

// Generate a unique reference ID for each transaction
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
  [Markup.button.callback('View Transactions', 'admin_view_transactions')],
  [Markup.button.callback('Send Message', 'admin_send_message')],
  [Markup.button.callback('Mark Paid', 'admin_mark_paid')],
]);

// Check if User is Admin
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

// Persistent User State Functions
async function getUserState(userId) {
  // Check in-memory cache first
  let userState = userStates[userId];
  if (userState) {
    return userState;
  }

  // Fetch from Firestore
  const doc = await db.collection('userStates').doc(userId).get();
  if (doc.exists) {
    userState = doc.data();
    userStates[userId] = userState; // Update cache
    return userState;
  } else {
    // Initialize new user state
    userState = { wallets: [], bankDetails: null, hasReceivedDeposit: false };
    userStates[userId] = userState; // Update cache
    return userState;
  }
}

async function saveUserState(userId) {
  const userState = userStates[userId];
  if (userState) {
    await db.collection('userStates').doc(userId).set(userState);
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

// /start Command
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

// Handle Bank Name and Account Number Input
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.awaitingBankName) {
    const bankNameInput = ctx.message.text.trim().toLowerCase();
    const bank = bankList.find((b) => {
      const bankNames = [b.name.toLowerCase(), ...b.aliases.map(alias => alias.toLowerCase())];
      return bankNames.includes(bankNameInput);
    });

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

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${userState.accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
          Markup.button.callback('❌ No', 'confirm_bank_no'),
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
    userState.messageRecipientId = ctx.message.text.trim();
    userState.awaitingUserIdForMessage = false;
    userState.awaitingMessageContent = true;
    await saveUserState(userId); // Save user state
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
    await saveUserState(userId); // Save user state
  } else {
    // Call next() to allow other handlers to process the message
    return next();
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

  // Reset Temporary States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.currentWalletIndex = null;
  userState.awaitingBankName = false;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId); // Save user state

  await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

  // Log linked bank to Admin
  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);
});

bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.reply('⚠️ It seems there was an error. Let\'s try again.');

  // Reset Temporary States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.awaitingBankName = true;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId); // Save user state

  return ctx.reply('Please enter your bank name:');
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

// Learn About Base Command
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

  await ctx.replyWithMarkdown(`*${content.title}*\n\n${content.text}`, Markup.inlineKeyboard(navigationButtons));
}

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const chatId = ctx.chat.id;
  const messageId = ctx.callbackQuery.message.message_id;

  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('Invalid page.');
  }

  await ctx.editMessageText(`*${baseContent[index].title}*\n\n${baseContent[index].text}`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        ...(index > 0 ? [[Markup.button.callback('⬅️ Back', `base_page_${index - 1}`)]] : []),
        ...(index < baseContent.length - 1 ? [[Markup.button.callback('Next ➡️', `base_page_${index + 1}`)]] : []),
      ],
    },
  });

  await ctx.answerCbQuery(); // Acknowledge the callback query
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
  await ctx.answerCbQuery(); // Acknowledge the callback query
});

bot.action('support_not_received', async (ctx) => {
  await ctx.reply('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
  await ctx.answerCbQuery(); // Acknowledge the callback query
});

bot.action('support_contact', async (ctx) => {
  await ctx.reply('You can contact our support team at @your_support_username.');
  await ctx.answerCbQuery(); // Acknowledge the callback query
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

// Handle View Transaction Callback
bot.action(/view_transaction_(.+)/, async (ctx) => {
  const referenceId = ctx.match[1];
  const userId = ctx.from.id.toString();

  try {
    const transactionsSnapshot = await db.collection('transactions')
      .where('userId', '==', userId)
      .where('referenceId', '==', referenceId)
      .get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('⚠️ Transaction not found.');
    }

    const tx = transactionsSnapshot.docs[0].data();
    const transactionHash = tx.transactionHash;

    // Generate Block Explorer URL
    const blockExplorerUrl = `https://sepolia.etherscan.io/tx/${transactionHash}`;

    let message = '💰 **Transaction Details**:\n\n';
    message += `Reference ID: ${tx.referenceId}\n`;
    message += `Amount: ${tx.amount} ${tx.asset}\n`;
    message += `Status: ${tx.status || 'Pending'}\n`;
    message += `Date: ${new Date(tx.timestamp).toLocaleString()}\n`;
    message += `\n🔗 [View on Sepolia Etherscan](${blockExplorerUrl})`;

    await ctx.replyWithMarkdown(message, {
      disable_web_page_preview: true,
    });

    await ctx.answerCbQuery(); // Acknowledge the callback query
  } catch (error) {
    console.error('Error fetching transaction:', error);
    await ctx.reply('⚠️ Unable to fetch transaction details. Please try again later.');
    await ctx.answerCbQuery(); // Acknowledge the callback query
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
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `User ID: ${tx.userId}\n`;
        message += `Reference ID: ${tx.referenceId}\n`;
        message += `Amount: ${tx.amount} ${tx.asset}\n`;
        message += `Status: ${tx.status || 'Pending'}\n`;
        message += `Date: ${new Date(tx.timestamp).toLocaleString()}\n\n`;
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
    // Admin mark-paid function
    try {
      const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
      if (pendingTransactions.empty) {
        return ctx.reply('No pending transactions found.');
      }

      pendingTransactions.forEach(async (transaction) => {
        const data = transaction.data();
        await db.collection('transactions').doc(transaction.id).update({ status: 'Paid' });

        // Notify the user
        await bot.telegram.sendMessage(data.userId, `🎉 Your transaction with reference ID ${data.referenceId} has been marked as paid!`);
      });

      await ctx.reply('All pending transactions marked as paid.');
    } catch (error) {
      console.error('Error marking transactions as paid:', error);
      await ctx.reply('⚠️ Error marking transactions as paid. Please try again later.');
    }
  }
});

// Handle Admin Messaging Input
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
    const recipientId = ctx.message.text.trim();
    // Validate recipientId is a number
    if (!/^\d+$/.test(recipientId)) {
      return ctx.reply('❌ Invalid User ID. Please enter a valid numerical User ID:');
    }
    userState.messageRecipientId = recipientId;
    userState.awaitingUserIdForMessage = false;
    userState.awaitingMessageContent = true;
    await saveUserState(userId); // Save user state
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
    await saveUserState(userId); // Save user state
  } else {
    // Call next() to allow other handlers to process the message
    return next();
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
      const usersSnapshot = await db.collection('userStates').get();

      let userId;
      let userState;

      usersSnapshot.forEach((doc) => {
        const data = doc.data();
        const wallet = data.wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
        if (wallet) {
          userId = doc.id;
          userState = data;
        }
      });

      if (!userId || !userState) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const wallet = userState.wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());

      // Check if Wallet has Linked Bank
      if (!wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 Deposit Received: ${amount} ${asset}. Please link a bank account to receive your payout securely.`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`);
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      // Log the referenceId
      console.log('referenceId:', referenceId);

      // Notify User of Successful Deposit
      await bot.telegram.sendMessage(userId,
        `Hello ${wallet.bank.accountName},\n\nA deposit of ${amount} ${asset} was received on your wallet address: \`${walletAddress}\`.\n\nYour transaction is being processed. You’ll receive NGN ${payout} in your ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} shortly.\n\nWe'll notify you once the process is complete.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📊 View Transaction',
                  callback_data: `view_transaction_${referenceId}`,
                },
              ],
            ],
          },
        }
      );

      // Notify Admin with Transaction Details
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID,
        `⚡️ User ${userId} received ${amount} ${asset}.\n\n📝 Transaction ID: ${transactionHash}\n🔗 Reference ID: ${referenceId}\n\nProcessing NGN ${payout} to ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} now.`
      );

      // Store Transaction in Firebase
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

      return res.status(200).send('OK');
    }
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

// Launch Bot
bot.launch({
  dropPendingUpdates: true, // Optional: Drop pending updates on restart
})
  .then(() => console.log('DirectPay bot is live!'))
  .catch((err) => console.error('Error launching bot:', err));

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

//STAY ONCHAIN 🌍🌐
