const { WizardScene, Markup } = require('telegraf');
const admin = require('firebase-admin');

const db = admin.firestore();

const sellScene = new WizardScene(
  'sell_scene',
  // Step 1: Amount and Asset
  async (ctx) => {
    // Default user state if not fetched from Firestore
    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false, lastSellAsset: 'USDC' };
    const lastAsset = userState.lastSellAsset || 'USDC';
    const msg = userState.usePidgin
      ? `Step 1/4: How much ${lastAsset} you wan sell? Enter amount (e.g., 10):`
      : `Step 1/4: How much ${lastAsset} do you want to sell? Enter amount (e.g., 10):`;
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('Change Asset', 'change_asset')],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.wizard.next();
  },
  // Step 2: Validate Amount and Select Network
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return ctx.reply('Please enter an amount.');
    const amount = parseFloat(ctx.message.text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('Invalid amount. Try again:', Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'cancel_sell')]
      ]));
    }

    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
    ctx.wizard.state.data = { userId: ctx.from.id, amount: (amount * 1e6).toString() }; // USDC has 6 decimals

    const msg = userState.usePidgin
      ? 'Step 2/4: Which network you dey use? Pick one:'
      : 'Step 2/4: Which network are you using? Select one:';
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('Solana', 'network_SOLANA')],
      [Markup.button.callback('Ethereum', 'network_ETHEREUM')],
      [Markup.button.callback('Base', 'network_BASE')],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.wizard.next();
  },
  // Step 3: Bank Selection
  async (ctx) => {
    if (!ctx.callbackQuery) return ctx.reply('Please select a network.');
    const network = ctx.callbackQuery.data.split('_')[1];
    const chainIdMap = { SOLANA: 101, ETHEREUM: 1, BASE: 8453 };
    const assetMap = {
      SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana
      ETHEREUM: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
      BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    };
    ctx.wizard.state.data.chainId = chainIdMap[network];
    ctx.wizard.state.data.asset = assetMap[network];
    ctx.wizard.state.data.networkName = network;

    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
    const msg = userState.usePidgin
      ? 'Step 3/4: Where you wan send the cash? Pick bank or add new one:'
      : 'Step 3/4: Where do you want the cash sent? Select or add a bank:';
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback('Select Bank', 'select_bank')],
      [Markup.button.callback('Add New Bank', 'add_bank')],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.wizard.next();
  },
  // Step 4: Summary and Connect Wallet
  async (ctx) => {
    if (!ctx.callbackQuery) return ctx.reply('Please select a bank option.');
    if (ctx.callbackQuery.data === 'add_bank') {
      return ctx.scene.enter('bank_linking_scene_temp', { fromSell: true });
    }

    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
    const bankDetails = userState.bankDetails || { bankName: 'Test Bank', accountNumber: '1234567890' }; // Default if not set
    ctx.wizard.state.data.bankDetails = bankDetails;

    // Store session in Firestore
    const referenceId = `${ctx.wizard.state.data.userId}-${Date.now()}`;
    await db.collection('sessions').doc(referenceId).set({
      userId: ctx.wizard.state.data.userId,
      amount: ctx.wizard.state.data.amount, // In wei (6 decimals for USDC)
      asset: ctx.wizard.state.data.asset,
      chainId: ctx.wizard.state.data.chainId,
      bankDetails,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = userState.usePidgin
      ? `Step 4/4: Summary:\nSell: ${ctx.wizard.state.data.amount / 1e6} USDC (${ctx.wizard.state.data.networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`
      : `Step 4/4: Summary:\nSell: ${ctx.wizard.state.data.amount / 1e6} USDC (${ctx.wizard.state.data.networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`;
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${ctx.wizard.state.data.userId}&session=${referenceId}`)],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.scene.leave(); // Exit scene, frontend takes over
  }
);

// Handle bank linking return
sellScene.enter(async (ctx) => {
  if (ctx.scene.state.bankDetails) {
    ctx.wizard.state.data = ctx.scene.state;
    ctx.wizard.state.data.userId = ctx.from.id;
    delete ctx.scene.state.bankDetails;

    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
    const { amount, networkName, bankDetails, asset, chainId } = ctx.wizard.state.data;
    const referenceId = `${ctx.wizard.state.data.userId}-${Date.now()}`;
    await db.collection('sessions').doc(referenceId).set({
      userId: ctx.wizard.state.data.userId,
      amount,
      asset,
      chainId,
      bankDetails,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = userState.usePidgin
      ? `Step 4/4: Summary:\nSell: ${amount / 1e6} USDC (${networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`
      : `Step 4/4: Summary:\nSell: ${amount / 1e6} USDC (${networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`;
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${ctx.wizard.state.data.userId}&session=${referenceId}`)],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.scene.leave();
  }
});

// Cancel action
sellScene.action('cancel_sell', async (ctx) => {
  await ctx.reply('Sell cancelled.');
  return ctx.scene.leave();
});

// Network selection actions
sellScene.action(/network_(.*)/, async (ctx) => {
  ctx.wizard.selectStep(2);
  return sellScene.steps[2](ctx);
});

// Placeholder for bank selection (replace with real logic)
sellScene.action('select_bank', async (ctx) => {
  const userDoc = await db.collection('users').doc(ctx.wizard.state.data.userId.toString()).get();
  const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
  ctx.wizard.state.data.bankDetails = userState.bankDetails || { bankName: 'Test Bank', accountNumber: '1234567890' };
  return ctx.wizard.next();
});

// Placeholder for changing asset (optional)
sellScene.action('change_asset', async (ctx) => {
  const userDoc = await db.collection('users').doc(ctx.wizard.state.data?.userId.toString() || ctx.from.id.toString()).get();
  const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
  await ctx.reply(userState.usePidgin ? 'For now, we only support USDC. Continue?' : 'Currently, only USDC is supported. Continue?', Markup.inlineKeyboard([
    [Markup.button.callback('Yes', 'continue')],
    [Markup.button.callback('❌ Cancel', 'cancel_sell')]
  ]));
});

sellScene.action('continue', async (ctx) => {
  return ctx.wizard.selectStep(1);
});

module.exports = sellScene;
