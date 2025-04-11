import React, { useEffect, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { RelayClient } from '@reservoir0x/relay-sdk';
import { ethers } from 'ethers';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

function ConnectWalletApp() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);
  const [isConfirmed, setIsConfirmed] = useState(false);

  const relayClient = new RelayClient({
    apiKey: process.env.REACT_APP_RELAY_API_KEY,
    baseUrl: 'https://api.relay.link',
  });

  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId');
  const session = urlParams.get('session');
  const baseUrl = process.env.REACT_APP_WEBAPP_URL || 'https://directpay.onrender.com';
  const blockradarAddress = '0xa5f565650890fba1824ee0f21ebbbf660a179934';

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0 && !status) {
      fetchTransactionDetailsAndQuote();
    }
  }, [ready, authenticated, wallets]);

  const fetchTransactionDetailsAndQuote = async () => {
    try {
      const wallet = wallets[0];
      const walletAddress = wallet.address;
      setStatus('Connecting wallet...');
      await axios.post(`${baseUrl}/webhook/wallet-connected`, { userId, walletAddress });

      setStatus('Fetching session...');
      const { data } = await axios.get(`${baseUrl}/api/session`, { params: { userId, session } });
      const { amount, asset, chainId } = data;

      setStatus('Fetching quote...');
      const quoteResponse = await relayClient.actions.getQuote({
        user: walletAddress,
        originChainId: chainId,
        originCurrency: asset,
        destinationChainId: 8453,
        destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        recipient: blockradarAddress,
        amount,
        refundTo: walletAddress,
      });
      setQuote(quoteResponse);
      setStatus('Review the quote and confirm.');
    } catch (err) {
      setError(`Error: ${err.message}`);
      await axios.post(`${baseUrl}/webhook/error`, { userId, error: err.message });
    }
  };

  const handleConfirm = async () => {
    setIsConfirmed(true);
    await executeTransactions();
  };

  const executeTransactions = async () => {
    try {
      const wallet = wallets[0];
      const walletAddress = wallet.address;
      const provider = new ethers.providers.Web3Provider(wallet.provider);
      const signer = provider.getSigner();

      if (wallet.chainId !== `eip155:${quote.steps[0].items[0].data.chainId}`) {
        await wallet.switchChain(quote.steps[0].items[0].data.chainId);
      }

      // Approval (for ERC20 only)
      if (quote.details.currencyIn.currency.address !== '0x0000000000000000000000000000000000000000') {
        setStatus('Requesting approval...');
        const tokenContract = new ethers.Contract(quote.details.currencyIn.currency.address, ERC20_ABI, signer);
        const spender = quote.steps[0].items[0].data.to;
        const amount = quote.details.currencyIn.amount;

        const allowance = await tokenContract.allowance(walletAddress, spender);
        if (ethers.BigNumber.from(allowance).lt(amount)) {
          const approvalTx = await tokenContract.approve(spender, amount);
          setStatus('Waiting for approval...');
          const approvalReceipt = await approvalTx.wait();
          await axios.post(`${baseUrl}/webhook/approval-confirmed`, {
            userId,
            walletAddress,
            txHash: approvalReceipt.transactionHash,
          });
        }
      }

      // Deposit
      setStatus('Initiating deposit...');
      const txData = quote.steps[0].items[0].data;
      const transaction = {
        to: txData.to,
        data: txData.data,
        value: ethers.BigNumber.from(txData.value),
        gasLimit: ethers.BigNumber.from(txData.gas),
        maxFeePerGas: ethers.BigNumber.from(txData.maxFeePerGas),
        maxPriorityFeePerGas: ethers.BigNumber.from(txData.maxPriorityFeePerGas),
      };

      const txResponse = await signer.sendTransaction(transaction);
      setStatus('Waiting for deposit...');
      const depositReceipt = await txResponse.wait();

      await axios.post(`${baseUrl}/webhook/deposit-confirmed`, {
        userId,
        walletAddress,
        txHash: depositReceipt.transactionHash,
        amount: quote.details.currencyIn.amount,
        chainId: quote.details.currencyIn.currency.chainId,
      });

      setStatus('Deposit complete!');
    } catch (err) {
      setError(`Error: ${err.message}`);
      await axios.post(`${baseUrl}/webhook/error`, { userId, error: err.message });
    }
  };

  return (
    <div style={{ padding: '20px', textAlign: 'center', fontFamily: 'Arial, sans-serif' }}>
      <h1>DirectPay Wallet</h1>
      {authenticated ? (
        <>
          <p>Wallet: {wallets[0]?.address}</p>
          {quote && (
            <div style={{ margin: '20px 0', textAlign: 'left', maxWidth: '400px', marginLeft: 'auto', marginRight: 'auto' }}>
              <h3>Transaction Quote</h3>
              <p><strong>Selling:</strong> {quote.details.currencyIn.amountFormatted} {quote.details.currencyIn.currency.symbol} ({quote.details.currencyIn.currency.name}) - ${quote.details.currencyIn.amountUsd}</p>
              <p><strong>Receiving:</strong> {quote.details.currencyOut.amountFormatted} {quote.details.currencyOut.currency.symbol} ({quote.details.currencyOut.currency.name}) - ${quote.details.currencyOut.amountUsd}</p>
              <p><strong>Total Impact:</strong> {quote.details.totalImpact.usd} USD ({quote.details.totalImpact.percent}%)</p>
              <p><strong>Swap Impact:</strong> {quote.details.swapImpact.usd} USD ({quote.details.swapImpact.percent}%)</p>
            </div>
          )}
          <p>Status: {status}</p>
          {error && <p style={{ color: 'red' }}>{error}</p>}
          {!isConfirmed && quote && (
            <button onClick={handleConfirm} style={{ padding: '10px 20px', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '5px' }}>
              Confirm Transaction
            </button>
          )}
          <button onClick={logout} style={{ padding: '10px 20px', marginLeft: '10px', backgroundColor: '#f44336', color: 'white', border: 'none', borderRadius: '5px' }}>
            Disconnect
          </button>
        </>
      ) : (
        <button onClick={login} style={{ padding: '10px 20px', backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: '5px' }}>
          Connect Wallet
        </button>
      )}
    </div>
  );
}

export default ConnectWalletApp;
