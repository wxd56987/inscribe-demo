const fs = require("fs").promises;
const path = require("path");
const { keys } = require("@cmdcode/crypto-utils");
const { Address, Tap, Tx, Signer } = require("@cmdcode/tapscript");
const { default: axios } = require("axios");

// 找零地址
const changeAddress =
  "bc1pvuf4p9etxgkw09855etxaf3gx2up2gk320c9cfdf38wfdffr4ctqz3dxe2";
// 铭刻地址默认自己，这里可以铭刻给其他人
const toAddress =
  "bc1pvuf4p9etxgkw09855etxaf3gx2up2gk320c9cfdf38wfdffr4ctqz3dxe2";
// 私钥
const pk = "96b2ca2a6499e6a1d9497285dca16df8ca5aef6cd77c10e3c41ee40b9e50f63a";
// 费率 可以请求接口查询 测试网 https://mempool-testnet.fractalbitcoin.io/api/v1/fees/recommended
// 正式网 https://mempool.fractalbitcoin.io/api/v1/fees/recommended
const feeRate = 5;
// 铭刻类型
const INSCRIBE_TYPE = "image/webp";
// 默认揭示铭文 330 sats
const INSCRIBE_SATOSHI = 330;

const rootPath = process.cwd();

// btc 铭文脚本构造
async function generateScript(pubkey) {
  const ec = new TextEncoder();
  const mimetype = ec.encode(INSCRIBE_TYPE);

  const filePath = path.join(rootPath, "imgs/348981.webp");
  const inscribeImg = await fs.readFile(filePath);

  const script = [
    pubkey,
    "OP_CHECKSIG",
    "OP_0",
    "OP_IF",
    ec.encode("ord"),
    "01",
    mimetype,
    "OP_0",
    inscribeImg,
    "OP_ENDIF",
  ];

  return script;
}

// 铭文taproot地址生成
async function generateInscribeAddress(seckey) {
  const pubkey = keys.get_pubkey(seckey, true);
  const script = await generateScript(pubkey);

  const tapleaf = Tap.encodeScript(script);

  const [tpubkey] = Tap.getPubKey(pubkey, { target: tapleaf });
  const address = Address.p2tr.fromPubKey(tpubkey, "main");

  return address;
}

// 预估交易费，为了找零
async function estimateBtcTxSize(inputs, outputs, isReveal, secret) {
  const pubkey = keys.get_pubkey(secret, true);
  const seckey = keys.get_seckey(secret);

  const script = await generateScript(pubkey);

  const tapleaf = Tap.encodeScript(script);
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf });

  const vin = inputs.map((item) => {
    return {
      txid: item.txid,
      vout: item.vout,
      sequence: item.sequence,
      prevout: {
        value: item.utxo,
        scriptPubKey: isReveal ? ["OP_1", tpubkey] : seckey,
      },
    };
  });

  const vout = outputs.map((item) => {
    return {
      value: item.utxo,
      scriptPubKey: item.script,
    };
  });

  const txdata = Tx.create({
    vin,
    vout,
  });
  if (isReveal) {
    const sig = Signer.taproot.sign(seckey, txdata, 0, { extension: tapleaf });
    txdata.vin[0].witness = [sig, script, cblock];
  } else {
    const [tseckey] = Tap.getSecKey(seckey);

    const sig = Signer.taproot.sign(tseckey, txdata, 0, {});
    txdata.vin[0].witness = [sig];
  }

  return Tx.util.getTxSize(txdata).vsize;
}

// 构造commit 交易
async function buildCommitTx(privateKeyHex) {
  try {
    const secret = keys.gen_seckey();
    const commitAddress = await generateInscribeAddress(secret);
    const btcUtxo = await fetchUtxo();

    if (!btcUtxo.length) {
      console.log("Insufficient balance");
    }

    const size = Math.floor((42 + 272 * 2 + 128 * 2) / 4 + 128);
    let networkFee = feeRate * size;

    const commitAmount = INSCRIBE_SATOSHI;

    const inputs = [];

    let allInput = 0;

    btcUtxo.forEach((utxo) => {
      inputs.push({
        txid: utxo.txid,
        vout: utxo.vout,
        sequence: 0,
        utxo: utxo.satoshi,
      });
      allInput += utxo.satoshi;
    });

    const outputs = [
      {
        utxo: commitAmount + 154 * feeRate,
        script: Address.toScriptPubKey(commitAddress),
        address: commitAddress,
      },
      {
        utxo: allInput - commitAmount - networkFee,
        script: Address.toScriptPubKey(changeAddress),
        address: changeAddress,
      },
    ];

    const inputsReveal = [];

    btcUtxo.forEach((utxo) => {
      inputsReveal.push({
        txid: utxo.txid,
        vout: utxo.vout,
        sequence: 0,
        utxo: utxo.satoshi,
      });
    });

    const outputsReveal = [
      {
        utxo: INSCRIBE_SATOSHI,
        script: Address.toScriptPubKey(commitAddress),
      },
    ];
    // 预估 commit tx 交易
    const estimateTxSize = await estimateBtcTxSize(
      inputs,
      outputs,
      false,
      secret
    );
    // 预估 reveal tx 交易
    const estimateTxRevealSize = await estimateBtcTxSize(
      inputsReveal,
      outputsReveal,
      true,
      secret
    );

    if (!estimateTxSize) {
      console.log("Insufficient estimateTxSize", estimateTxSize);
    }

    networkFee = feeRate * estimateTxSize;

    const revealNetworkFee = feeRate * estimateTxRevealSize;

    // 构造交易
    const txdata = Tx.create({
      vin: inputs.map((input) => ({
        txid: input.txid,
        vout: input.vout,
        prevout: {
          value: input.utxo,
          scriptPubKey: Address.toScriptPubKey(changeAddress),
        },
      })),
      vout: [
        {
          value: commitAmount + revealNetworkFee,
          scriptPubKey: Address.toScriptPubKey(commitAddress),
        },
        {
          value: allInput - commitAmount - revealNetworkFee - networkFee,
          scriptPubKey: Address.toScriptPubKey(changeAddress),
        },
      ],
    });
    const [tseckey] = Tap.getSecKey(privateKeyHex);
    for (let i = 0; i < inputs.length; i++) {
      const sig = Signer.taproot.sign(tseckey, txdata, i);
      txdata.vin[i].witness = [sig];
    }

    const psbtHex = Tx.encode(txdata).hex;
    // TODO: 这里调用广播交易  https://open-api-fractal-testnet.unisat.io/v1/indexer/local_pushtx

    const { data: commitTxid } = await broadcastTx(psbtHex);

    console.log(`CommitTxid: ${commitTxid}`);

    const revealTxid = await buildRevealTx(
      secret,
      commitTxid,
      0,
      commitAmount + revealNetworkFee
    );

    return revealTxid;
  } catch (error) {
    console.log("commit tx error", error);
  }
}

async function broadcastTx(txHex) {
  const url = ` https://open-api-fractal-testnet.unisat.io/v1/indexer/local_pushtx`;
  const response = await axios({
    url,
    method: "POST",
    data: JSON.stringify({ txHex }),
  });
  return response.data;
}

async function fetchUtxo() {
  const url = ` https://open-api-fractal-testnet.unisat.io/v1/indexer/address/${changeAddress}/utxo-data`;
  const response = await axios({
    url,
  });
  const utxos = response.data.data.utxo;
  // TODO: 真实开发中需要根据预估的交易fee，取input的数量
  return utxos;
}

// 揭示交易
async function buildRevealTx(secret, txid, vout, sendAmount) {
  const seckey = keys.get_seckey(secret);
  const pubkey = keys.get_pubkey(secret, true);

  const script = await generateScript(pubkey);

  const network = "main";

  const tapleaf = Tap.encodeScript(script);
  const [tpubkey, cblock] = Tap.getPubKey(pubkey, { target: tapleaf });
  const address = Address.p2tr.fromPubKey(tpubkey, network);
  const txdata = Tx.create({
    vin: [
      {
        txid: txid,
        vout: vout,
        prevout: {
          value: sendAmount,
          scriptPubKey: ["OP_1", tpubkey],
        },
      },
    ],
    vout: [
      {
        value: INSCRIBE_SATOSHI,
        scriptPubKey: Address.toScriptPubKey(toAddress),
      },
    ],
  });

  const sig = Signer.taproot.sign(seckey, txdata, 0, { extension: tapleaf });
  txdata.vin[0].witness = [sig, script, cblock];
  const isValid = Signer.taproot.verify(txdata, 0, { pubkey, throws: true });
  const { data: revealTxid } = await broadcastTx(Tx.encode(txdata).hex);

  return revealTxid;
}

async function main() {
  try {
    const txid = await buildCommitTx(pk);
    console.log(`CevealTxid: ${txid}`);
  } catch (error) {
    throw new Error("Failed to inscribe", error);
  }
}

main();
