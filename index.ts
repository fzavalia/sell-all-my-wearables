import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import fetch from "node-fetch";
import pLimit from "p-limit";
import multicallAbi from "./abis/Multicall3Abi.json";
import collectionAbi from "./abis/ERC721CollectionV2Abi.json";
import marketplaceAbi from "./abis/MarketplaceV2Abi.json";

const marketplaceAddress = "0x480a0f4e360E8964e68858Dd231c2922f1df45Ef";
const gasPrice = "79.7";

type SubgraphNFT = {
  id: string;
  contractAddress: string;
  tokenId: string;
  item: {
    blockchainId: string;
  };
  metadata: {
    wearable: {
      name: string;
    } | null;
    emote: {
      name: string;
    } | null;
  };
};

type SubgraphPricesResponse = {
  data: {
    orders: {
      price: string;
    }[];
    items: {
      price: string;
    }[];
  };
};

async function main() {
  try {
    const provider = getProvider();
    const wallet = loadWallet(provider);

    console.log("Fetching NFTs...");
    const subgraphNfts = await fetchSubgraphNfts(wallet.address);
    console.log(subgraphNfts);

    console.log("Fetching Unauthorized NFTs...");
    const unauthorizedNfts = await fetchUnauthorizedNfts(Array.from(subgraphNfts.values()), wallet);
    console.log(unauthorizedNfts);

    console.log(`Authorizing NFTs...`);
    await authorize(Array.from(unauthorizedNfts), wallet);

    console.log(`Fetching prices...`);
    const subgraphPrices = await fetchSubgraphPrices(Array.from(subgraphNfts.values()));
    console.log(subgraphPrices);

    console.log(`Selling NFTs...`);
    await sell(subgraphNfts, subgraphPrices, wallet);
  } catch (e) {
    console.error((e as Error).message);
  }
}

function getProvider(): ethers.Provider {
  return new ethers.JsonRpcProvider(process.env.RPC_URL!);
}

function loadWallet(provider: ethers.Provider): ethers.BaseWallet {
  return ethers.Wallet.fromPhrase(process.env.MNEMONIC!, provider);
}

async function fetchSubgraphNfts(account: string): Promise<Map<string, SubgraphNFT>> {
  const response = await fetch("https://api.thegraph.com/subgraphs/name/decentraland/collections-matic-mainnet", {
    method: "POST",
    body: JSON.stringify({
      query: `
      {
        nfts(where: { owner: "${account.toLowerCase()}" }) {
          id
          contractAddress
          tokenId
          item {
            blockchainId
          }
          metadata {
            wearable {
              name
            }
            emote {
              name
            }
          }
        }
      }
      `,
    }),
  });

  const nfts = (await response.json()).data.nfts;

  return new Map(nfts.map((nft: SubgraphNFT) => [nft.id, nft]));
}

async function fetchUnauthorizedNfts(subgraphNfts: SubgraphNFT[], wallet: ethers.BaseWallet): Promise<Set<string>> {
  const multicall = new ethers.Contract("0xcA11bde05977b3631167028862bE2a173976CA11", multicallAbi, wallet);

  const addresses = Array.from(new Set(subgraphNfts.map((subgraphNft) => subgraphNft.contractAddress)));

  const calls = addresses.map((address) => {
    const iface = new ethers.Interface(collectionAbi);
    const data = iface.encodeFunctionData("isApprovedForAll", [wallet.address, marketplaceAddress]);

    return [address, data];
  });

  const aggregateResult = await multicall.aggregate.staticCall(calls);

  return (aggregateResult[1] as string[]).reduce((acc, next, i) => {
    if (!ethers.AbiCoder.defaultAbiCoder().decode(["bool"], next)[0]) {
      acc.add(addresses[i]);
    }
    return acc;
  }, new Set<string>());
}

async function authorize(addresses: string[], wallet: ethers.BaseWallet) {
  const tsx: ethers.ContractTransactionResponse[] = [];

  let nonce = await wallet.getNonce();

  for (const address of addresses) {
    const collection = new ethers.Contract(address, collectionAbi, wallet);
    tsx.push(
      await collection.setApprovalForAll(marketplaceAddress, true, {
        nonce: nonce++,
        gasPrice: ethers.parseUnits(gasPrice, "gwei"),
      })
    );
  }

  await Promise.all(tsx.map((tsx) => tsx.wait(20)));
}

async function fetchSubgraphPrices(subgraphNfts: SubgraphNFT[]): Promise<Map<string, bigint>> {
  const limit = pLimit(5);

  const input = subgraphNfts.map((subgraphNft) =>
    limit(async () => [subgraphNft.id, await fetchSubgraphPrice(subgraphNft)] as [string, bigint])
  );

  const results = await Promise.all(input);

  return new Map(results.filter(([, price]) => price > 0n));
}

async function fetchSubgraphPrice(subgraphNft: SubgraphNFT): Promise<bigint> {
  const id = `${subgraphNft.contractAddress}-${subgraphNft.item.blockchainId}`;

  const response = await fetch("https://api.thegraph.com/subgraphs/name/decentraland/collections-matic-mainnet", {
    method: "POST",
    body: JSON.stringify({
      query: `
      {
        orders(
          first: 1,
          where: {
            item: "${id}",
            status:open
          },
          orderBy:price,
          orderDirection:asc
        ) {
          price
        }
        items(
          first: 1,
          where: {
            id: "${id}"
          }
        ) {
          price
        }
      }
      `,
    }),
  });
  const subgraphPricesResponse: SubgraphPricesResponse = await response.json();
  const lowestOrderPrice = ethers.toBigInt(subgraphPricesResponse.data.orders[0]?.price ?? "0");
  const itemPrice = ethers.toBigInt(subgraphPricesResponse.data.items[0]?.price ?? "0");

  const price = (() => {
    if (lowestOrderPrice === 0n) {
      return itemPrice;
    }

    if (itemPrice === 0n) {
      return lowestOrderPrice;
    }

    return lowestOrderPrice < itemPrice ? lowestOrderPrice : itemPrice;
  })();

  return (price * 1_000_000n) / 1_100_000n; // 10% discount
}

async function sell(nfts: Map<string, SubgraphNFT>, prices: Map<string, bigint>, wallet: ethers.BaseWallet) {
  const tsx: ethers.ContractTransactionResponse[] = [];

  let nonce = await wallet.getNonce();

  const block = await wallet.provider!.getBlock("latest");
  const blockTimestamp = block!.timestamp;
  const expiration = blockTimestamp + 31557600; // + 1 year to current timestamp

  for (const [id, price] of prices.entries()) {
    const marketplace = new ethers.Contract(marketplaceAddress, marketplaceAbi, wallet);
    const nft = nfts.get(id)!;

    if (!nft) {
      console.warn(`NFT not found: ${id}`);
      continue;
    }

    tsx.push(
      await marketplace.createOrder(nft.contractAddress, nft.tokenId, price, ethers.toBigInt(expiration), {
        nonce: nonce++,
        gasPrice: ethers.parseUnits(gasPrice, "gwei"),
      })
    );
  }

  await Promise.all(tsx.map((tsx) => tsx.wait()));
}

main();
