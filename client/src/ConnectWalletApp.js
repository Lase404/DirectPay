// client/src/ConnectWalletApp.js
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';
import './ConnectWalletApp.css';

const ConnectWalletApp = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const fetchSession = async () => {
      const urlParams = new URLSearchParams(location.search);
      console.log('location.search:', location.search);
      console.log('location:', location);
      console.log('window.location.search (for comparison):', window.location.search);
      console.log('window.location:', window.location);
      const userId = urlParams.get('userId');
      const sessionId = urlParams.get('sessionId');
      console.log('Extracted userId:', userId, 'sessionId:', sessionId);

      if (!userId || !sessionId) {
        setError('Missing userId or sessionId in URL. Please return to Telegram and try again.');
        return;
      }

      try {
        console.log(`Fetching session from /api/session?userId=${userId}&sessionId=${sessionId}`);
        const response = await axios.get(`/api/session?userId=${userId}&sessionId=${sessionId}`);
        console.log('Session response:', response.data);
        setSession(response.data);
      } catch (err) {
        setError('Failed to fetch session: ' + err.message);
        console.error('Session fetch error:', err);
      }
    };

    if (ready && authenticated) {
      fetchSession();
    }
  }, [ready, authenticated, location.search]);

  const fetchQuote = async (walletAddress) => {
    if (!session) return;
    setLoading(true);
    try {
      console.log(`Fetching quote for wallet ${walletAddress}, session:`, session);
      const quoteResponse = await axios.post('https://api.relay.link/quote', {
        user: walletAddress,
        originChainId: session.chainId,
        originCurrency: session.token,
        destinationChainId: 8453,
        destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tradeType: 'EXACT_INPUT',
        recipient: session.blockradarWallet,
        amount: session.amountInWei,
        refundTo: walletAddress
      });
      console.log('Quote response:', quoteResponse.data);
      setQuote(quoteResponse.data);
      setError(null);
    } catch (err) {
      setError(`Failed to fetch quote: ${err.message}`);
      console.error('Quote fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSell = async () => {
    if (!wallets.length || !session || !quote) return;

    const wallet = wallets[0];
    const provider = await wallet.getEthersProvider();
    const signer = provider.getSigner();

    try {
      setLoading(true);
      if (session.token !== '0x0000000000000000000000000000000000000000') {
        console.log(`Approving token ${session.token} for amount ${session.amountInWei}`);
        const erc20Abi = ['function approve(address spender, uint256 amount) public returns (bool)'];
        const tokenContract = new ethers.Contract(session.token, erc20Abi, signer);
        const tx = await tokenContract.approve(quote.approvalAddress, session.amountInWei);
        await tx.wait();
        console.log('Approval transaction:', tx);
      }

      console.log('Executing sell transaction:', quote);
      const txResponse = await signer.sendTransaction({
        to: quote.to,
        data: quote.data,
        value: quote.value ? ethers.BigNumber.from(quote.value) : 0
      });
      await txResponse.wait();
      console.log('Sell transaction response:', txResponse);

      console.log('Notifying server of sell completion');
      await axios.post('/webhook/sell-completed', {
        userId: new URLSearchParams(location.search).get('userId'),
        sessionId: new URLSearchParams(location.search).get('sessionId'),
        txHash: txResponse.hash
      });

      setError('Sell completed successfully!');
    } catch (err) {
      setError(`Error during sell: ${err.message}`);
      console.error('Sell error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (wallets.length > 0 && session && !quote) {
      fetchQuote(wallets[0].address);
    }
  }, [wallets, session]);

  if (!ready) return <div>Loading...</div>;

  return (
    <div className="connect-wallet-app">
      <h1>DirectPay Wallet Connector</h1>
      {!authenticated ? (
        <button onClick={login}>Connect Wallet</button>
      ) : (
        <>
          <p>Connected: {wallets[0]?.address}</p>
          {session ? (
            <>
              <p>Amount: {ethers.utils.formatUnits(session.amountInWei, 6)} {session.token === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'Token'}</p>
              <p>To: {session.blockradarWallet}</p>
              {quote ? (
                <>
                  <p>Quote: {ethers.utils.formatUnits(quote.amountOut, 6)} USDC</p>
                  <p>Fees: {ethers.utils.formatEther(quote.feeDetails.totalFee)} ETH</p>
                  <button onClick={handleSell} disabled={loading}>
                    {loading ? 'Processing...' : 'Execute Sell'}
                  </button>
                </>
              ) : (
                <p>{loading ? 'Fetching quote...' : 'Waiting for quote...'}</p>
              )}
            </>
          ) : (
            <p>Fetching session...</p>
          )}
          <button onClick={logout}>Disconnect</button>
        </>
      )}
      {error && (
        <p className="error">
          {error}
          {error.includes('Missing userId or sessionId') && (
            <>
              <br />
              <a href="https://t.me/yourBotUsername">Return to Telegram</a>
            </>
          )}
        </p>
      )}
    </div>
  );
};

const App = () => (
  <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID} config={{}}>
    <ConnectWalletApp />
  </PrivyProvider>
);

export default App;
