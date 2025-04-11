const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 0: Parse input and validate with Relay.link
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await ctx.getUserState(userId);
    const args = ctx.message.text.split(' ').slice(1); // Remove /sell
    if (args.length !== 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Use: /sell <amount> <term/address> <chain> (e.g., /sell 100 USDC 1)'
        : '❌ Usage: /sell <amount> <term/address> <chain> (e.g., /sell 100 USDC 1)';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    const [amountStr, termOrAddress, chainIdStr] = args;
    const amount = parseFloat(amountStr);
    const chainId = parseInt(chainIdStr, 10);
    if (isNaN(amount) || amount <= 0 || isNaN(chainId)) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount or chain ID no correct. Try again.'
        : '❌ Invalid amount or chain ID. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.sellData = { amount, chainId, userId };
    const isAddress = ethers.utils.isAddress(termOrAddress);
    let response;

    try {
      const config = {
        method: 'post',
        url: 'https://api.relay.link/currencies/v1',
        headers: { 'Content-Type': 'application/json' },
        data: {
          chainIds: [chainId],
          verified: true,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: false,
          ...(isAddress ? { address: termOrAddress } : { term: termOrAddress }),
        },
      };
      response = await axios(config);
      const assets = response.data[0] || [];
      if (!assets.length) {
        const errorMsg = userState.usePidgin
          ? `❌ No asset found for "${termOrAddress}" on chain ${chainId}. Try again.`
          : `❌ No asset found for "${termOrAddress}" on chain ${chainId}. Please try again.`;
        await ctx.replyWithMarkdown(errorMsg);
        return ctx.scene.leave();
      }

      ctx.wizard.state.sellData.assets = assets;
      if (assets.length === 1) {
        ctx.wizard.state.sellData.selectedAsset = assets[0];
        return ctx.wizard.next();
      }

      let options = assets.map((asset, idx) => [
        Markup.button.callback(
          `${asset.symbol} (${asset.name}) - ${asset.address.slice(0, 6)}...`,
          `select_asset_${idx}`
        ),
      ]);
      const prompt = userState.usePidgin
        ? '📜 *Multiple Assets Found*\n\nPick the one you wan sell:'
        : '📜 *Multiple Assets Found*\n\nSelect the asset you want to sell:';
      await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(options));
      return ctx.wizard.next();
    } catch (error) {
      ctx.logger.error(`Error validating asset for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error checking asset. Try again later.');
      return ctx.scene.leave();
    }
  },
  // Step 1: Confirm asset selection (if multiple)
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    const userState = await ctx.getUserState(ctx.wizard.state.sellData.userId);
    const idx = parseInt(ctx.callbackQuery.data.split('_')[2], 10);
    const selectedAsset = ctx.wizard.state.sellData.assets[idx];
    ctx.wizard.state.sellData.selectedAsset = selectedAsset;

    const confirmMsg = userState.usePidgin
      ? `✅ *Asset Selected*\n\n` +
        `• *Symbol:* ${selectedAsset.symbol}\n` +
        `• *Name:* ${selectedAsset.name}\n` +
        `• *Address:* \`${selectedAsset.address}\`\n` +
        `• *Chain ID:* ${ctx.wizard.state.sellData.chainId}\n` +
        `• *Amount:* ${ctx.wizard.state.sellData.amount}\n\n` +
        `Na this one you wan sell?`
      : `✅ *Asset Selected*\n\n` +
        `• *Symbol:* ${selectedAsset.symbol}\n` +
        `• *Name:* ${selectedAsset.name}\n` +
        `• *Address:* \`${selectedAsset.address}\`\n` +
        `• *Chain ID:* ${ctx.wizard.state.sellData.chainId}\n` +
        `• *Amount:* ${ctx.wizard.state.sellData.amount}\n\n` +
        `Is this the asset you want to sell?`;
    await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_asset')],
      [Markup.button.callback('❌ No', 'retry_asset')],
    ]));
    return ctx.wizard.next();
  },
  // Step 2: Handle bank selection
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    const userId = ctx.wizard.state.sellData.userId;
    const userState = await ctx.getUserState(userId);

    if (ctx.callbackQuery.data === 'retry_asset') {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Okay, enter /sell again with correct details.'
        : '❌ Okay, please run /sell again with the correct details.');
      return ctx.scene.leave();
    }

    const walletsWithBank = userState.wallets.filter(w => w.bank);
    const linkedBank = walletsWithBank[0]?.bank; // Use first linked bank

    ctx.wizard.state.sellData.bankDetails = linkedBank;
    const bankMsg = userState.usePidgin
      ? `🏦 *Your Linked Bank*\n\n` +
        `• *Bank:* ${linkedBank.bankName}\n` +
        `• *Number:* ****${linkedBank.accountNumber.slice(-4)}\n` +
        `• *Name:* ${linkedBank.accountName}\n\n` +
        `You wan receive funds here or link new bank for this sell?`
      : `🏦 *Your Linked Bank*\n\n` +
        `• *Bank:* ${linkedBank.bankName}\n` +
        `• *Account Number:* ****${linkedBank.accountNumber.slice(-4)}\n` +
        `• *Account Name:* ${linkedBank.accountName}\n\n` +
        `Receive funds here or link a new bank for this sell?`;
    await ctx.replyWithMarkdown(bankMsg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Use This Bank', 'use_linked_bank')],
      [Markup.button.callback('🏦 Link New Bank', 'link_temp_bank')],
    ]));
    return ctx.wizard.next();
  },
  // Step 3: Connect wallet and fetch quote
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    const userId = ctx.wizard.state.sellData.userId;
    const userState = await ctx.getUserState(userId);

    if (ctx.callbackQuery.data === 'link_temp_bank') {
      await ctx.scene.enter('bank_linking_scene_temp');
      ctx.wizard.state.awaitingTempBank = true;
      return;
    }

    if (ctx.wizard.state.awaitingTempBank && ctx.scene.state.bankDetails) {
      ctx.wizard.state.sellData.bankDetails = ctx.scene.state.bankDetails;
      delete ctx.wizard.state.awaitingTempBank;
    }

    const connectMsg = userState.usePidgin
      ? '🔗 *Connect Your Wallet*\n\nClick below to connect your wallet via Privy:'
      : '🔗 *Connect Your Wallet*\n\nClick below to connect your wallet via Privy:';
    await ctx.replyWithMarkdown(connectMsg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${ctx.webhookDomain}/connect-wallet?userId=${userId}`)],
    ]));

    ctx.wizard.state.awaitingWallet = true;
    return ctx.wizard.next();
  },
  // Step 4: Fetch quote and execute
  async (ctx) => {
    const userId = ctx.wizard.state.sellData.userId;
    const userState = await ctx.getUserState(userId);

    if (!ctx.wizard.state.sellData.userAddress) {
      // Wallet address will be set via webhook
      return;
    }

    const { amount, chainId, selectedAsset, userAddress, bankDetails } = ctx.wizard.state.sellData;
    const amountInWei = ethers.utils.parseUnits(amount.toString(), selectedAsset.decimals).toString();

    try {
      const quoteResponse = await axios.post(
        'https://api.relay.link/quote',
        {
          user: userAddress,
          originChainId: chainId,
          originCurrency: selectedAsset.address,
          destinationChainId: 8453, // Base chain
          destinationCurrency: BLOCKRADAR_USDC_ADDRESS,
          tradeType: 'EXACT_INPUT',
          recipient: BLOCKRADAR_USDC_ADDRESS,
          amount: amountInWei,
          refundTo: userAddress,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );

      ctx.wizard.state.sellData.quote = quoteResponse.data[0];
      const quoteMsg = userState.usePidgin
        ? `📊 *Sell Quote*\n\n` +
          `• *From:* ${amount} ${selectedAsset.symbol} (Chain ${chainId})\n` +
          `• *To:* ${ethers.utils.formatUnits(quoteResponse.data[0].destination.amount, 6)} USDC (Base)\n` +
          `• *Fee:* ${quoteResponse.data[0].fee.amount} ${quoteResponse.data[0].fee.currency}\n\n` +
          `Ready to approve and sell?`
        : `📊 *Sell Quote*\n\n` +
          `• *From:* ${amount} ${selectedAsset.symbol} (Chain ${chainId})\n` +
          `• *To:* ${ethers.utils.formatUnits(quoteResponse.data[0].destination.amount, 6)} USDC (Base)\n` +
          `• *Fee:* ${quoteResponse.data[0].fee.amount} ${quoteResponse.data[0].fee.currency}\n\n` +
          `Ready to approve and sell?`;
      await ctx.replyWithMarkdown(quoteMsg, Markup.inlineKeyboard([
        [Markup.button.url('Approve & Execute', `${ctx.webhookDomain}/execute?userId=${userId}&quoteId=${quoteResponse.data[0].id}`)],
      ]));
      return ctx.scene.leave();
    } catch (error) {
      ctx.logger.error(`Error fetching quote for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error getting quote. Try again later.');
      return ctx.scene.leave();
    }
  }
);

function setup(bot, db, logger, getUserState, privy, blockradarUsdcAddress) {
  sellScene.getUserState = getUserState;
  sellScene.logger = logger;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;

  sellScene.action(/select_asset_(\d+)/, async (ctx) => {
    ctx.wizard.selectStep(1);
    await sellScene.steps[1](ctx);
  });

  sellScene.action('confirm_asset', async (ctx) => {
    ctx.wizard.selectStep(2);
    await sellScene.steps[2](ctx);
  });

  sellScene.action('use_linked_bank', async (ctx) => {
    ctx.wizard.selectStep(3);
    await sellScene.steps[3](ctx);
  });

  sellScene.action('link_temp_bank', async (ctx) => {
    ctx.wizard.selectStep(3);
    await sellScene.steps[3](ctx);
  });

  // Webhook to receive wallet connection
  bot.app.post('/webhook/wallet-connected', async (req, res) => {
    const { userId, walletAddress } = req.body;
    logger.info(`Wallet connected for user ${userId}: ${walletAddress}`);
    const userState = await getUserState(userId);
    await bot.telegram.sendMessage(userId, 
      userState.usePidgin
        ? `✅ Wallet connected: \`${walletAddress}\`. We dey prepare your sell now...`
        : `✅ Wallet connected: \`${walletAddress}\`. Preparing your sell now...`, 
      { parse_mode: 'Markdown' }
    );
    
    const session = bot.scene.sessions[userId];
    if (session && session.sell_scene) {
      session.sell_scene.sellData.userAddress = walletAddress;
      bot.scene.enter(userId, 'sell_scene', session.sell_scene, 4);
    }
    res.status(200).send('OK');
  });
}

module.exports = { sellScene, setup };
