const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const cache = new NodeCache({ stdTTL: 300 }); // 5-minute cache for quotes

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // **Step 1: Parse and Validate Input**
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in sell scene');
      await ctx.replyWithMarkdown(
        '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = { userId }; // Initialize state
    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state is null');
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for userId ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const input = ctx.message?.text?.replace('/sell', '').trim().split(/\s+/);
    sellScene.logger.info(`User ${userId} entered sell scene with input: ${ctx.message?.text || 'unknown'}`);

    if (!input || input.length < 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth'
        : '❌ Invalid format. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    const [amountStr, assetInput, chain] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter correct number like 100 or 0.5.'
        : '❌ Invalid amount. Please enter a valid number like 100 or 0.5.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    ctx.wizard.state = {
      userId,
      amount,
      assetInput,
      chain: chain.toLowerCase(),
      stepStartedAt: Date.now(),
    };

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '🔄 Dey check your asset and chain... E fit take small time.'
        : '🔄 Verifying your asset and chain... This may take a moment.',
    );

    try {
      const chainId = mapChainToId(ctx.wizard.state.chain);
      if (!chainId) {
        throw new Error(`Unsupported chain: ${ctx.wizard.state.chain}. Supported: eth, base, bnb, polygon`);
      }

      let assets;
      if (ethers.utils.isAddress(assetInput)) {
        assets = await validateAssetByAddress(assetInput, chainId, sellScene.relayClient);
      } else {
        assets = await validateAssetByTerm(assetInput, chainId, sellScene.relayClient);
      }

      const flattenedAssets = Array.isArray(assets) && Array.isArray(assets[0]) ? assets.flat() : assets;

      if (!flattenedAssets || flattenedAssets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No asset match your input for this chain. Check the symbol or address and try again.'
          : '❌ No matching assets found for this chain. Verify the symbol or address and try again.';
        await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', 'retry_sell')],
        ]));
        return ctx.scene.leave();
      }

      ctx.wizard.state.validatedAssets = flattenedAssets;
      if (flattenedAssets.length > 1) {
        const options = flattenedAssets.map((asset, index) => [
          Markup.button.callback(
            `${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)${asset.metadata.verified ? '' : ' (Unverified)'}`,
            `select_asset_${index}`,
          ),
        ]);
        options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? '🤔 Multiple assets dey. Pick the one you want:'
            : '🤔 Multiple assets found. Please select one:',
          Markup.inlineKeyboard(options),
        );
        ctx.wizard.state.stepStartedAt = Date.now();
        return ctx.wizard.next(); // Wait for asset selection
      } else {
        ctx.wizard.state.selectedAsset = flattenedAssets[0];
        ctx.wizard.state.isVerifiedAsset = flattenedAssets[0].metadata.verified; // Store verification status
        return ctx.wizard.selectStep(1); // Proceed to bank selection (Step 2)
      }
    } catch (error) {
      sellScene.logger.error(`Error validating asset for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? `❌ Error checking asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`
        : `❌ Error verifying asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`;
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }
  },
  // **Step 2: Select Asset (if multiple)**
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 2');
      await ctx.replyWithMarkdown(
        '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || { userId };
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state is null');
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for userId ${userId} in step 2: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    sellScene.logger.info(`User ${userId} reached step 2: asset selection`);

    if (Date.now() - ctx.wizard.state.stepStartedAt > INACTIVITY_TIMEOUT) {
      sellScene.logger.info(`User ${userId} timed out in asset selection`);
      await ctx.replyWithMarkdown(
        userState.usePidgin
          ? '⏰ You don wait too long. Start again with /sell.'
          : '⏰ You’ve been inactive too long. Please start over with /sell.',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '⏳ Dey wait for you to pick asset...'
        : '⏳ Waiting for you to select asset...',
    );
    // Note: This step waits for user action (handled by action handlers)
  },
  // **Step 3: Bank Selection**
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 3');
      await ctx.replyWithMarkdown(
        '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || { userId };
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state is null');
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for userId ${userId} in step 3: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const walletsWithBank = userState.wallets.filter((w) => w.bank);
    sellScene.logger.info(`User ${userId} reached bank selection step. Wallets with bank: ${walletsWithBank.length}`);

    if (!ctx.wizard.state.selectedAsset) {
      const errorMsg = userState.usePidgin
        ? '❌ No asset selected. Start again with /sell.'
        : '❌ No asset selected. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    const asset = ctx.wizard.state.selectedAsset;
    let amountInWei;
    try {
      amountInWei = ethers.utils.parseUnits(ctx.wizard.state.amount.toString(), asset.decimals).toString();
    } catch (error) {
      sellScene.logger.error(`Error parsing amount for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid for this asset. Start again with /sell.'
        : '❌ Invalid amount for this asset. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    ctx.wizard.state.amountInWei = amountInWei;
    ctx.wizard.state.stepStartedAt = Date.now();

    if (walletsWithBank.length === 0) {
      const prompt = userState.usePidgin
        ? '🏦 No bank linked yet. You wan link one for this sell? (Step 1/3)'
        : '🏦 No bank linked yet. Would you like to link one for this sell? (Step 1/3)';
      await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'link_temp_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]));
      return ctx.wizard.next();
    }

    const bankOptions = walletsWithBank.map((wallet, index) => [
      Markup.button.callback(
        `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`,
        `select_bank_${index}`,
      ),
    ]);
    bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
    bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

    const assetMsg = userState.usePidgin
      ? `✅ *Asset Confirmed* (Step 1/3)\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n\n` +
        `Where you want the funds go?`
      : `✅ *Asset Confirmed* (Step 1/3)\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n\n` +
        `Where would you like to receive the funds?`;
    await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
    return ctx.wizard.next();
  },
  // **Step 4: Prompt Wallet Connection with Optional Warning**
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 4');
      await ctx.replyWithMarkdown(
        '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || { userId };
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state is null');
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for userId ${userId} in step 4: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const { selectedAsset: asset, bankDetails, selectedWalletAddress, amountInWei, amount } = ctx.wizard.state;
    sellScene.logger.info(`User ${userId} reached step 4: wallet connection`);

    if (!asset || !bankDetails || !selectedWalletAddress || !amountInWei) {
      const errorMsg = userState.usePidgin
        ? '❌ Something miss for your sell. Start again with /sell.'
        : '❌ Missing details for your sell. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    // Fetch quote
    let quote = {
      fees: { gas: { amountUsd: '0' }, relayer: { amountUsd: '0' }, relayerGas: { amountUsd: '0' }, relayerService: { amountUsd: '0' }, app: { amountUsd: '0' } },
      details: {
        currencyIn: { currency: { symbol: asset.symbol }, amount: amount.toString(), amountUsd: amount.toString() },
        currencyOut: { currency: { symbol: 'USD' }, amount: amount.toString(), amountUsd: amount.toString() },
        totalImpact: { usd: '0', percent: '0%' },
        swapImpact: { usd: '0', percent: '0%' },
        rate: '1',
        slippageTolerance: { origin: { percent: '0%' }, destination: { percent: '0%' } },
        timeEstimate: 0,
      },
    };
    try {
      const cacheKey = `quote:${userId}:${asset.chainId}:${asset.address}:${amountInWei}`;
      let cachedQuote = cache.get(cacheKey);
      if (!cachedQuote) {
        cachedQuote = await sellScene.relayClient.getQuote({
          chainId: asset.chainId,
          tokenIn: asset.address,
          amountIn: amountInWei,
          currencyOut: 'USD',
          recipient: bankDetails.accountNumber,
        });
        cache.set(cacheKey, cachedQuote);
      }
      quote = cachedQuote;
      sellScene.logger.info(`Quote for user ${userId}: ${JSON.stringify(quote)}`);
    } catch (error) {
      sellScene.logger.warn(`Failed to fetch quote for user ${userId}: ${error.message}, using fallback`);
    }

    // Calculate total fees
    const totalFeesUsd = (
      parseFloat(quote.fees.gas?.amountUsd || '0') +
      parseFloat(quote.fees.relayer?.amountUsd || '0') +
      parseFloat(quote.fees.relayerGas?.amountUsd || '0') +
      parseFloat(quote.fees.relayerService?.amountUsd || '0') +
      parseFloat(quote.fees.app?.amountUsd || '0')
    ).toFixed(2);

    // USD conversion for currencyIn
    let amountInUsd = parseFloat(quote.details.currencyIn.amountUsd || amount).toFixed(2);
    try {
      const rate = sellScene.exchangeRates[asset.symbol.toUpperCase()] || (asset.symbol.toUpperCase() === 'USDC' ? 1.0 : null);
      if (rate) amountInUsd = (amount * rate).toFixed(2);
    } catch (error) {
      sellScene.logger.warn(`Failed to convert ${asset.symbol} to USD for user ${userId}: ${error.message}`);
    }

    ctx.wizard.state.sessionId = uuidv4();
    ctx.wizard.state.stepStartedAt = Date.now();

    // Add warning if asset is unverified
    const warning = ctx.wizard.state.isVerifiedAsset
      ? ''
      : '⚠ **Warning:** This asset is unverified and may carry risks. Proceed with caution.\n\n';

    const confirmMsg = userState.usePidgin
      ? `${warning}📝 *Sell Details* (Step 2/3)\n\n` +
        `*You Sell:* ${amount} ${asset.symbol}\n` +
        `*Value in USD:* $${amountInUsd}\n` +
        `*You Receive:* ${quote.details.currencyOut.amount} ${quote.details.currencyOut.currency.symbol}\n` +
        `*Received in USD:* $${quote.details.currencyOut.amountUsd}\n` +
        `*Total Fees:* $${totalFeesUsd}\n` +
        `*Total Impact:* $${quote.details.totalImpact.usd} (${quote.details.totalImpact.percent})\n` +
        `*Swap Impact:* $${quote.details.swapImpact.usd} (${quote.details.swapImpact.percent})\n` +
        `*Exchange Rate:* 1 ${asset.symbol} = ${quote.details.rate} ${quote.details.currencyOut.currency.symbol}\n` +
        `*Slippage Tolerance:* ${quote.details.slippageTolerance.destination.percent}\n` +
        `*Est. Time:* ${quote.details.timeEstimate} seconds\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
        `Ready to connect your wallet?`
      : `${warning}📝 *Sell Details* (Step 2/3)\n\n` +
        `*You Sell:* ${amount} ${asset.symbol}\n` +
        `*Value in USD:* $${amountInUsd}\n` +
        `*You Receive:* ${quote.details.currencyOut.amount} ${quote.details.currencyOut.currency.symbol}\n` +
        `*Received in USD:* $${quote.details.currencyOut.amountUsd}\n` +
        `*Total Fees:* $${totalFeesUsd}\n` +
        `*Total Impact:* $${quote.details.totalImpact.usd} (${quote.details.totalImpact.percent})\n` +
        `*Swap Impact:* $${quote.details.swapImpact.usd} (${quote.details.swapImpact.percent})\n` +
        `*Exchange Rate:* 1 ${asset.symbol} = ${quote.details.rate} ${quote.details.currencyOut.currency.symbol}\n` +
        `*Slippage Tolerance:* ${quote.details.slippageTolerance.destination.percent}\n` +
        `*Est. Time:* ${quote.details.timeEstimate} seconds\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
        `Ready to connect your wallet?`;
    await ctx.replyWithMarkdown(confirmMsg);

    const sessionData = {
      userId,
      amountInWei,
      token: asset.address,
      chainId: asset.chainId,
      bankDetails: bankDetails,
      blockradarWallet: selectedWalletAddress,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      isVerifiedAsset: ctx.wizard.state.isVerifiedAsset,
      quote: {
        currencyIn: {
          symbol: asset.symbol,
          amount: amount.toString(),
          amountUsd: amountInUsd,
        },
        currencyOut: {
          symbol: quote.details.currencyOut.currency.symbol,
          amount: quote.details.currencyOut.amount,
          amountUsd: quote.details.currencyOut.amountUsd,
        },
        totalFeesUsd,
        totalImpact: quote.details.totalImpact,
        swapImpact: quote.details.swapImpact,
        rate: quote.details.rate,
        slippageTolerance: quote.details.slippageTolerance,
        timeEstimate: quote.details.timeEstimate,
      },
    };

    sellScene.logger.info(`Storing session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}`);
    try {
      await sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).set(sessionData);
      sellScene.logger.info(`Successfully stored session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}`);
    } catch (error) {
      sellScene.logger.error(`Failed to store session for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    // Prepare session data for walletconnectapp.js
    const queryParams = new URLSearchParams({
      userId: sessionData.userId,
      amountInWei: sessionData.amountInWei,
      token: sessionData.token,
      chainId: sessionData.chainId.toString(),
      bankDetails: JSON.stringify(sessionData.bankDetails),
      blockradarWallet: sessionData.blockradarWallet,
      status: sessionData.status,
      createdAt: sessionData.createdAt,
      expiresAt: sessionData.expiresAt,
      isVerifiedAsset: sessionData.isVerifiedAsset.toString(),
      quote: JSON.stringify(sessionData.quote),
    }).toString();

    const connectUrl = `${sellScene.webhookDomain}/connect?${queryParams}`;
    sellScene.logger.info(`Wallet Connection URL for user ${userId}: ${connectUrl}`);

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? `✅ *Sell Ready!* (Step 3/3)\nConnect wallet in 15 mins:\n[${connectUrl}](${connectUrl})`
        : `✅ *Sell Ready!* (Step 3/3)\nConnect wallet within 15 minutes:\n[${connectUrl}](${connectUrl})`,
      Markup.inlineKeyboard([
        [Markup.button.url('Connect Wallet', connectUrl)],
        [Markup.button.callback('⬅ Back', 'back_to_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );

    return ctx.wizard.next();
  },
  // **Step 5: Wait for Wallet Connection and Client-Side Execution**
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 5');
      await ctx.replyWithMarkdown(
        '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || { userId };
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state is null');
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for userId ${userId} in step 5: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const sessionId = ctx.wizard.state.sessionId;
    sellScene.logger.info(`User ${userId} reached step 5: waiting for wallet connection, sessionId: ${sessionId}`);

    if (!sessionId) {
      const errorMsg = userState.usePidgin
        ? '❌ No session found. Start again with /sell.'
        : '❌ No session found. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }

    try {
      const sessionDoc = await sellScene.db.collection('sessions').doc(sessionId).get();
      if (!sessionDoc.exists) {
        sellScene.logger.error(`Session ${sessionId} not found for user ${userId}`);
        const errorMsg = userState.usePidgin
          ? '❌ Session no dey again. Start again with /sell.'
          : '❌ Session not found. Please start over with /sell.';
        await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', 'retry_sell')],
        ]));
        return ctx.scene.leave();
      }

      const session = sessionDoc.data();
      const now = new Date();
      if (new Date(session.expiresAt) < now) {
        sellScene.logger.info(`Session ${sessionId} for user ${userId} has expired`);
        await sellScene.db.collection('sessions').doc(sessionId).update({ status: 'expired' });
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? '⏰ Sell process don timeout. Start again with /sell.'
            : '⏰ Sell process timed out. Please start over with /sell.',
          Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
        );
        return ctx.scene.leave();
      }

      if (session.status === 'completed') {
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? '✅ Sell complete! Check your bank for the money.'
            : '✅ Sell completed! Check your bank for the payout.',
          Markup.inlineKeyboard([[Markup.button.callback('🔄 Sell Again', 'retry_sell')]]),
        );
        return ctx.scene.leave();
      }

      await ctx.replyWithMarkdown(
        userState.usePidgin
          ? '⏳ Dey wait for you to finish the sell for browser... (Step 3/3)\nMake you connect your wallet quick quick!'
          : '⏳ Waiting for you to complete the sell in your browser... (Step 3/3)\nPlease connect your wallet promptly!',
        Markup.inlineKeyboard([
          [Markup.button.callback('⬅ Back', 'back_to_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]),
      );
    } catch (error) {
      sellScene.logger.error(`Error checking session for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error checking your sell. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error checking your sell. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_sell')],
      ]));
      return ctx.scene.leave();
    }
  },
);

// **Middleware to Ensure UserId**
sellScene.use((ctx, next) => {
  if (ctx.from && ctx.from.id) {
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = ctx.wizard.state.userId || ctx.from.id.toString();
    sellScene.logger.debug(`Ensured userId ${ctx.wizard.state.userId} in middleware`);
  } else {
    sellScene.logger.warn('Missing ctx.from in middleware');
  }
  return next();
});

// **Helper Functions**
function mapChainToId(chain) {
  const chainMap = {
    eth: 1,
    ethereum: 1,
    base: 8453,
    bnb: 56,
    bsc: 56,
    polygon: 137,
    matic: 137,
  };
  return chainMap[chain.toLowerCase()];
}

async function validateAssetByAddress(address, chainId, relayClient) {
  try {
    sellScene.logger.info(`Validating asset by address: ${address} on chainId: ${chainId}`);
    const response = await axios.post(
      'https://api.relay.link/currencies/v1',
      {
        chainIds: [chainId],
        term: address,
        verified: false,
        limit: 10,
        includeAllChains: false,
        useExternalSearch: true,
        depositAddressOnly: true,
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    sellScene.logger.info(`Relay.link response for address ${address}: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    sellScene.logger.error(`Address validation failed for address ${address}: ${error.message}`);
    throw error;
  }
}

async function validateAssetByTerm(term, chainId, relayClient) {
  try {
    sellScene.logger.info(`Validating asset by term: ${term} on chainId: ${chainId}`);
    const response = await axios.post(
      'https://api.relay.link/currencies/v1',
      {
        chainIds: [chainId],
        term,
        verified: false,
        limit: 10,
        includeAllChains: false,
        useExternalSearch: true,
        depositAddressOnly: true,
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    sellScene.logger.info(`Relay.link response for term ${term}: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    sellScene.logger.error(`Term validation failed for term ${term}: ${error.message}`);
    throw error;
  }
}

// **Actions**
sellScene.action(/select_asset_(\d+)/, async (ctx) => {
  if (!ctx.from || !ctx.from.id) {
    sellScene.logger.error('Missing ctx.from or ctx.from.id in select_asset action');
    await ctx.replyWithMarkdown(
      '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const userId = ctx.from.id.toString();
  ctx.wizard.state = ctx.wizard.state || { userId };
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state is null');
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for userId ${userId} in select_asset: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const assets = ctx.wizard.state.validatedAssets;
  sellScene.logger.info(`User ${userId} selected asset index ${index}`);

  if (!assets || index < 0 || index >= assets.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Asset no valid. Pick again or cancel.'
        : '❌ Invalid asset selection. Try again or cancel.',
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅ Back', 'back_to_asset')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.wizard.state.selectedAsset = assets[index];
  ctx.wizard.state.isVerifiedAsset = assets[index].metadata.verified; // Store verification status
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(2); // Proceed to bank selection
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
  if (!ctx.from || !ctx.from.id) {
    sellScene.logger.error('Missing ctx.from or ctx.from.id in select_bank action');
    await ctx.replyWithMarkdown(
      '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const userId = ctx.from.id.toString();
  ctx.wizard.state = ctx.wizard.state || { userId };
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state is null');
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for userId ${userId} in select_bank: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const walletsWithBank = userState.wallets.filter((w) => w.bank);
  sellScene.logger.info(`User ${userId} selected bank index ${index}`);

  if (index < 0 || index >= walletsWithBank.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Bank no valid. Pick again or cancel.'
        : '❌ Invalid bank selection. Try again or cancel.',
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅ Back', 'back_to_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.wizard.state.bankDetails = walletsWithBank[index].bank;
  ctx.wizard.state.selectedWalletAddress = walletsWithBank[index].address;
  ctx.wizard.state.stepStartedAt = Date.now();

  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(3); // Proceed to wallet connection
});

sellScene.action('link_temp_bank', async (ctx) => {
  if (!ctx.from || !ctx.from.id) {
    sellScene.logger.error('Missing ctx.from or ctx.from.id in link_temp_bank action');
    await ctx.replyWithMarkdown(
      '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const userId = ctx.from.id.toString();
  ctx.wizard.state = ctx.wizard.state || { userId };
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state is null');
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for userId ${userId} in link_temp_bank: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`User ${userId} chose to link a temporary bank`);
  ctx.wizard.state.awaitingTempBank = true;
  await ctx.scene.enter('bank_linking_scene_temp');
  await ctx.answerCbQuery();
});

sellScene.action('back_to_asset', async (ctx) => {
  if (!ctx.from || !ctx.from.id) {
    sellScene.logger.error('Missing ctx.from or ctx.from.id in back_to_asset action');
    await ctx.replyWithMarkdown(
      '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const userId = ctx.from.id.toString();
  ctx.wizard.state = ctx.wizard.state || { userId };
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state is null');
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for userId ${userId} in back_to_asset: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const assets = ctx.wizard.state.validatedAssets;
  sellScene.logger.info(`User ${userId} returned to asset selection`);

  if (!assets || assets.length === 0) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ No assets to pick. Start again with /sell.'
        : '❌ No assets to select. Please start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const options = assets.map((asset, index) => [
    Markup.button.callback(
      `${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)${asset.metadata.verified ? '' : ' (Unverified)'}`,
      `select_asset_${index}`,
    ),
  ]);
  options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

  await ctx.replyWithMarkdown(
    userState.usePidgin
      ? '🤔 Pick the asset you want:'
      : '🤔 Please select an asset:',
    Markup.inlineKeyboard(options),
  );
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(1);
});

sellScene.action('back_to_bank', async (ctx) => {
  if (!ctx.from || !ctx.from.id) {
    sellScene.logger.error('Missing ctx.from or ctx.from.id in back_to_bank action');
    await ctx.replyWithMarkdown(
      '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const userId = ctx.from.id.toString();
  ctx.wizard.state = ctx.wizard.state || { userId };
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state is null');
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for userId ${userId} in back_to_bank: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing your account. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const walletsWithBank = userState.wallets.filter((w) => w.bank);
  sellScene.logger.info(`User ${userId} returned to bank selection`);

  if (!ctx.wizard.state.selectedAsset) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ No asset selected. Start again with /sell.'
        : '❌ No asset selected. Please start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const bankOptions = walletsWithBank.map((wallet, index) => [
    Markup.button.callback(
      `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`,
      `select_bank_${index}`,
    ),
  ]);
  bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
  bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

  const assetMsg = userState.usePidgin
    ? `✅ *Asset Confirmed* (Step 1/3)\n\n` +
      `*Symbol:* ${ctx.wizard.state.selectedAsset.symbol}\n` +
      `*Name:* ${ctx.wizard.state.selectedAsset.name}\n` +
      `*Address:* \`${ctx.wizard.state.selectedAsset.address}\`\n` +
      `*Chain:* ${ctx.wizard.state.chain}\n` +
      `*Amount:* ${ctx.wizard.state.amount} ${ctx.wizard.state.selectedAsset.symbol}\n\n` +
      `Where you want the funds go?`
    : `✅ *Asset Confirmed* (Step 1/3)\n\n` +
      `*Symbol:* ${ctx.wizard.state.selectedAsset.symbol}\n` +
      `*Name:* ${ctx.wizard.state.selectedAsset.name}\n` +
      `*Address:* \`${ctx.wizard.state.selectedAsset.address}\`\n` +
      `*Chain:* ${ctx.wizard.state.chain}\n` +
      `*Amount:* ${ctx.wizard.state.amount} ${ctx.wizard.state.selectedAsset.symbol}\n\n` +
      `Where would you like to receive the funds?`;
  await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(2);
});

sellScene.action('retry_sell', async (ctx) => {
  const userId = ctx.from?.id?.toString() || ctx.wizard.state?.userId || 'unknown';
  sellScene.logger.info(`User ${userId} requested to retry sell`);
  await ctx.answerCbQuery();
  await ctx.scene.enter('sell_scene');
});

sellScene.action('cancel_sell', async (ctx) => {
  const userId = ctx.wizard.state?.userId || ctx.from?.id?.toString() || 'unknown';
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state is null');
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for userId ${userId} in cancel_sell: ${error.message}`);
    userState = { usePidgin: false }; // Fallback
  }

  sellScene.logger.info(`User ${userId} cancelled the sell process`);
  await ctx.replyWithMarkdown(
    userState.usePidgin
      ? '❌ Sell cancelled. You fit start again with /sell.'
      : '❌ Sell process cancelled. You can start over with /sell.',
    Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
  );
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// **Setup Function**
function setup(bot, db, logger, getUserState, updateUserState, relayClient, privyClient, exchangeRates, chains) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.privyClient = privyClient;
  sellScene.exchangeRates = exchangeRates;
  sellScene.chains = chains;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;

  bot.on('callback_query', async (ctx) => {
    if (ctx.scene.current?.id === 'bank_linking_scene_temp' && ctx.wizard.state?.awaitingTempBank) {
      if (ctx.callbackQuery.data === 'confirm_bank_temp') {
        const userId = ctx.wizard.state?.userId || ctx.from?.id?.toString();
        if (!userId) {
          sellScene.logger.error('Missing userId in bank_linking_scene_temp callback');
          await ctx.replyWithMarkdown(
            '❌ Unable to process your request due to missing user information. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
          );
          await ctx.answerCbQuery();
          return;
        }
        sellScene.logger.info(`User ${userId} confirmed temporary bank linking`);
        ctx.wizard.state = ctx.wizard.state || { userId };
        ctx.wizard.state.bankDetails = ctx.scene.state.bankDetails;
        ctx.wizard.state.selectedWalletAddress = ctx.scene.state.walletAddress || ctx.wizard.state.selectedWalletAddress;
        ctx.wizard.state.stepStartedAt = Date.now();
        await ctx.answerCbQuery();
        await ctx.wizard.selectStep(2); // Go to Step 3: Bank Selection
      }
    }
  });
}

module.exports = { sellScene, setup };
