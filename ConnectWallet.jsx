import React, { useEffect, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { RelayClient } from '@reservoir0x/relay-sdk';
import { ethers } from 'ethers';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
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

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0 && !status) {
      fetchTransactionDetailsAndQuote();
    }
  }, [ready, authenticated, wallets]);

  const fetchTransactionDetailsAndQuote = async () => {
    try {
      const wallet = wallets[0];
      const walletAddress = wallet.address;

      // Notify backend of wallet connection
      setStatus('Connecting wallet...');
      await axios.post(`${baseUrl}/webhook/wallet-connected`, { userId, walletAddress });

      // Fetch session details
      setStatus('Fetching transaction details...');
      const { data } = await axios.get(`${baseUrl}/api/session`, { params: { userId, session } });
      const { amount, asset, chainId } = data;

      // Fetch Relay quote
      setStatus('Fetching quote...');
      const quoteResponse = await relayClient.actions.getQuote({
        user: walletAddress,
        originChainId: chainId,
        originCurrency: asset,
        destinationChainId: 8453,
        destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        recipient: '0xa5f565650890fba1824ee0f21ebbbf660a179934', // Blockradar USDC address
        amount,
        refundTo: walletAddress,
      });
      setQuote(quoteResponse);
      setStatus('Review the quote below and confirm to proceed.');
    } catch (err) {
      setError(`Error: ${err.response?.status === 404 ? 'Session not found' : err.message}`);
      await axios.post(`${baseUrl}/webhook/error`, { userId, error: err.message });
    }
  };

  const handleConfirm = async () => {
    setIsConfirmed(true);
    await initiateApprovalAndDeposit();
  };

  const initiateApprovalAndDeposit = async () => {
    try {
      const wallet = wallets[0];
      const walletAddress = wallet.address;
      const provider = new ethers.providers.Web3Provider(wallet.provider);
      const signer = provider.getSigner();

      // Approval using ERC20_ABI
      setStatus('Requesting approval...');
      const tokenContract = new ethers.Contract(quote.details.currencyIn.currency.address, ERC20_ABI, signer);
      const spender = quote.steps[0].items[0].data.to; // Relay deposit address from quote
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
      } else {
        setStatus('Approval already granted.');
        await axios.post(`${baseUrl}/webhook/approval-confirmed`, {
          userId,
          walletAddress,
          txHash: 'already-approved',
        });
      }

      // Deposit using Relay SDK with quote data
      setStatus('Initiating deposit...');
      const depositTx = await relayClient.actions.deposit({
        chainId: quote.details.currencyIn.currency.chainId,
        toChainId: 8453,
        walletAddress,
        currency: quote.details.currencyIn.currency.address,
        toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: quote.details.currencyIn.amount,
        walletClient: wallet,
      });
      setStatus('Waiting for deposit...');
      const depositReceipt = await depositTx.wait();

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

  if (!ready) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h1>Loading...</h1>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', textAlign: 'center', fontFamily: 'Arial, sans-serif' }}>
      <h1>DirectPay Wallet</h1>
      {authenticated ? (
        <>
          <p>Wallet: {wallets[0]?.address}</p>
          {quote && (
            <div style={{ margin: '20px 0', textAlign: 'left', maxWidth: '400px', marginLeft: 'auto', marginRight: 'auto' }}>
              <h3>Transaction Quote</h3>
              <p>
                <strong>Selling:</strong> {quote.details.currencyIn.amountFormatted} {quote.details.currencyIn.currency.symbol} ({quote.details.currencyIn.currency.name})<br />
                <strong>Value:</strong> ${quote.details.currencyIn.amountUsd}
              </p>
              <p>
                <strong>Receiving:</strong> {quote.details.currencyOut.amountFormatted} {quote.details.currencyOut.currency.symbol} ({quote.details.currencyOut.currency.name})<br />
                <strong>Value:</strong> ${quote.details.currencyOut.amountUsd}
              </p>
              <p>
                <strong>Total Impact:</strong> {quote.details.totalImpact.usd} USD ({quote.details.totalImpact.percent}%)<br />
                <strong>Swap Impact:</strong> {quote.details.swapImpact.usd} USD ({quote.details.swapImpact.percent}%)
              </p>
            </div>
          )}
          <p>Status: {status}</p>
          {error && <p style={{ color: 'red' }}>{error}</p>}
          {!isConfirmed && quote && (
            <button onClick={handleConfirm} style={{ padding: '10px 20px', margin: '5px', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
              Confirm and Approve
            </button>
          )}
          <button onClick={logout} style={{ padding: '10px 20px', margin: '5px', backgroundColor: '#f44336', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
            Disconnect
          </button>
        </>
      ) : (
        <button onClick={login} style={{ padding: '10px 20px', margin: '5px', backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
          Connect Wallet
        </button>
      )}
    </div>
  );
}

export default ConnectWalletApp;
