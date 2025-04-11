const { Markup } = require('telegraf');
const { WizardScene } = require('telegraf/scenes/wizard'); // Correct import
const admin = require('firebase-admin');
const axios = require('axios');
const ethers = require('ethers'); // Already required for ethers.utils

const db = admin.firestore();

const sellScene = new WizardScene(
  'sell_scene',
  // Step 1: Parse /sell command and verify asset
  async (ctx) => {
    if (!ctx.message || !ctx.message.text.startsWith('/sell')) {
      await ctx.reply('Use: /sell <amount> <asset> <chain> (e.g., /sell 10 USDC Ethereum)');
      return ctx.scene.leave();
    }

    const [, amountStr, asset, chain] = ctx.message.text.split(' ');
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0 || !asset || !chain) {
      await ctx.reply('Invalid input. Use: /sell <amount> <asset> <chain>');
      return ctx.scene.leave();
    }

    ctx.wizard.state.data = { userId: ctx.from.id, amount: amount.toString() };
    const chainIdMap = { Ethereum: 1, Base: 8453, Polygon: 137, BSC: 56 }; // Add more EVM chains as needed
    const chainId = chainIdMap[chain];
    if (!chainId) {
      await ctx.reply('Unsupported chain. Supported: Ethereum, Base, Polygon, BSC');
      return ctx.scene.leave();
    }
    ctx.wizard.state.data.chainId = chainId;
    ctx.wizard.state.data.networkName = chain;

    // Verify asset with Relay
    try {
      const response = await axios.post('https://api.relay.link/currencies/v1', {
        chainIds: [chainId],
        term: asset.toLowerCase(),
        verified: true,
        limit: 1,
        includeAllChains: false,
        useExternalSearch: true,
        depositAddressOnly: true,
      }, { headers: { 'Content-Type': 'application/json' } });

      const currencies = response.data[0];
      if (!currencies || currencies.length === 0) {
        await ctx.reply(`No verified asset found for "${asset}" on ${chain}.`);
        return ctx.scene.leave();
      }

      ctx.wizard.state.data.asset = currencies[0];
      const { symbol, name, address } = ctx.wizard.state.data.asset;
      await ctx.reply(
        `Found asset:\nSymbol: ${symbol}\nName: ${name}\nAddress: ${address}\nConfirm this asset?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes', 'confirm_asset')],
          [Markup.button.callback('❌ No', 'cancel_sell')]
        ])
      );
    } catch (err) {
      await ctx.reply(`Error verifying asset: ${err.message}`);
      return ctx.scene.leave();
    }
    return ctx.wizard.next();
  },
  // Step 2: Bank selection or linking
  async (ctx) => {
    if (!ctx.callbackQuery || ctx.callbackQuery.data === 'cancel_sell') {
      await ctx.reply('Sell cancelled.');
      return ctx.scene.leave();
    }

    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
    const bankDetails = userState.bankDetails;

    ctx.wizard.state.data.amountWei = ethers.utils.parseUnits(
      ctx.wizard.state.data.amount,
      ctx.wizard.state.data.asset.decimals
    ).toString();

    let msg = userState.usePidgin
      ? `Step 2/3: You wan sell ${ctx.wizard.state.data.amount} ${ctx.wizard.state.data.asset.symbol} (${ctx.wizard.state.data.networkName}). `
      : `Step 2/3: You’re selling ${ctx.wizard.state.data.amount} ${ctx.wizard.state.data.asset.symbol} (${ctx.wizard.state.data.networkName}). `;

    if (bankDetails) {
      msg += userState.usePidgin
        ? `We go send cash to ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}. Use this bank?`
        : `Funds will be sent to ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}. Use this bank?`;
      ctx.wizard.state.data.bankDetails = bankDetails;
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_bank')],
        [Markup.button.callback('✏️ Link New Bank', 'add_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')]
      ]));
    } else {
      msg += userState.usePidgin
        ? 'You no get bank linked. Add one now?'
        : 'No bank linked. Add one now?';
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Add Bank', 'add_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')]
      ]));
    }
    return ctx.wizard.next();
  },
  // Step 3: Summary and wallet connect
  async (ctx) => {
    if (!ctx.callbackQuery) return ctx.reply('Please select an option.');
    if (ctx.callbackQuery.data === 'add_bank') {
      return ctx.scene.enter('bank_linking_scene_temp', { fromSell: true });
    }
    if (ctx.callbackQuery.data === 'cancel_sell') {
      await ctx.reply('Sell cancelled.');
      return ctx.scene.leave();
    }

    const userDoc = await db.collection('users').doc(ctx.from.id.toString()).get();
    const userState = userDoc.exists ? userDoc.data() : { usePidgin: false };
    const bankDetails = ctx.wizard.state.data.bankDetails;

    const referenceId = `${ctx.wizard.state.data.userId}-${Date.now()}`;
    await db.collection('sessions').doc(referenceId).set({
      userId: ctx.wizard.state.data.userId,
      amount: ctx.wizard.state.data.amountWei,
      asset: ctx.wizard.state.data.asset.address,
      chainId: ctx.wizard.state.data.chainId,
      bankDetails,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = userState.usePidgin
      ? `Step 3/3: Summary:\nSell: ${ctx.wizard.state.data.amount} ${ctx.wizard.state.data.asset.symbol} (${ctx.wizard.state.data.networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`
      : `Step 3/3: Summary:\nSell: ${ctx.wizard.state.data.amount} ${ctx.wizard.state.data.asset.symbol} (${ctx.wizard.state.data.networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`;
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${ctx.wizard.state.data.userId}&session=${referenceId}`)],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.scene.leave();
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

    await db.collection('users').doc(ctx.from.id.toString()).set(
      { bankDetails },
      { merge: true }
    );

    const amountWei = ethers.utils.parseUnits(amount, asset.decimals).toString();
    const referenceId = `${ctx.wizard.state.data.userId}-${Date.now()}`;
    await db.collection('sessions').doc(referenceId).set({
      userId: ctx.wizard.state.data.userId,
      amount: amountWei,
      asset: asset.address,
      chainId,
      bankDetails,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = userState.usePidgin
      ? `Step 3/3: Summary:\nSell: ${amount} ${asset.symbol} (${networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`
      : `Step 3/3: Summary:\nSell: ${amount} ${asset.symbol} (${networkName})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConnect your wallet to continue:`;
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${ctx.wizard.state.data.userId}&session=${referenceId}`)],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')]
    ]));
    return ctx.scene.leave();
  }
});

// Actions
sellScene.action('confirm_asset', (ctx) => ctx.wizard.next());
sellScene.action('confirm_bank', (ctx) => ctx.wizard.next());
sellScene.action('cancel_sell', async (ctx) => {
  await ctx.reply('Sell cancelled.');
  return ctx.scene.leave();
});

module.exports = sellScene;
