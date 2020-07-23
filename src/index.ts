import { ApiPromise, WsProvider } from "@polkadot/api";
import qrcode from "@polkadot/react-qr/qrcode";
import { createSignPayload, createFrames } from "@polkadot/react-qr/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import { SignerPayload } from "@polkadot/types/interfaces";
import program from "commander";
import * as fs from "fs";
import * as http from "http";
//@ts-ignore
import opn from "opn";
import express from "express";
import bodyParser from "body-parser";

import scanAddress from "./actions/scanAddress";
import broadcast from "./actions/broadcast";
import { sleep } from "./helpers";

const parse = (commaSeparated: string): string[] => {
  if (commaSeparated.indexOf(",") !== -1) {
    return commaSeparated.split(",");
  } else {
    return [commaSeparated];
  }
}

// function getQrString (value: Uint8Array): string {
//   const qr = qrcode(0, 'M');

//   // HACK See out qrcode stringToBytes override as used internally. This
//   // will only work for the case where we actuall pass `Bytes` in here
//   // eslint-disable-next-line @typescript-eslint/no-explicit-any
//   qr.addData(value as any, 'Byte');
//   qr.make();

//   return qr.createASCII(0, 2);
// }

function getDataUrl (value: Uint8Array): string {
  const qr = qrcode(0, 'M');

  // HACK See out qrcode stringToBytes override as used internally. This
  // will only work for the case where we actuall pass `Bytes` in here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qr.addData(value as any, 'Byte');
  qr.make();

  return qr.createDataURL(4, 0);
}

type Options = {
  address: string;
  final: boolean;
  otherSigners: string,
  threshold: string;
  csv: string;
  wsEndpoint: string;
}

const payout = async (opts: Options) => {
  const { final, otherSigners, threshold, csv, wsEndpoint } = opts;
  let { address } = opts;

  if (!address) {
    throw new Error("Must supply the signer address with the --address option. Please user `scanAddress` command first!");
  }
  if (!csv) {
    throw new Error("Need to pass a --csv <filepath> option.");
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(wsEndpoint),
  });

  const csvFile = fs.readFileSync(csv, { encoding: "utf-8" });
  const nonce = (await api.query.system.account(address)).nonce; 

  const signedBlock = await api.rpc.chain.getBlock();
  const options = {
    blockHash: signedBlock.block.header.hash,
    era: api.createType("ExtrinsicEra", {
      current: signedBlock.block.header.number,
      period: 200,
    }),
    nonce,
    blockNumber: signedBlock.block.header.number,
  };

  // const calls = csvFile
  //   .split("\n")
  //   .filter(entry => entry !== "")
  //   .map(entry => api.tx.purchase.payout(entry));
  // const batchCall = api.tx.utility.batch(calls);
  // let call = !!final
  //   ? api.tx.multisig.asMulti(threshold, parse(otherSigners), null, batchCall.toHex(), true, 2000000)
  //   : api.tx.multisig.approveAsMulti(threshold, parse(otherSigners), null, blake2AsHex(batchCall.toU8a()), 2000000);
  const call = api.tx.balances.transfer(csvFile.split("\n")[0], 1*10**12);

  //@ts-ignore
  const payload: SignerPayload = api.createType("SignerPayload", {
    genesisHash: api.genesisHash,
    runtimeVersion: api.runtimeVersion,
    version: api.extrinsicVersion,
    ...options,
    address: address,
    method: call.method,
  });

  const exPayload = api.createType("ExtrinsicPayload", payload.toPayload(), { version: payload.toPayload().version });
  const signPayload = createSignPayload(address, 2, exPayload.toU8a(), api.genesisHash);
  const frames = createFrames(signPayload);
  let dataUrl = getDataUrl(frames[0]);

  console.log("\nOpening the QR code in the browser.")
  const randomPort = Math.floor(7800 + Math.random() * 99);
  const app = express();
  app.use(
    express.static(__dirname + '/vendor'),
  );
  app.use(bodyParser.json());
  app.get('/', function(req, res) {
    res.send(`
<script src="qr-scanner.umd.min.js"></script>
<script>
  window.addEventListener('load', () => {
    console.log('loaded');
    QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js';
    const videoElem = document.getElementById("video");
    const qrScanner = new QrScanner(videoElem, result => {
      const resultElem = document.getElementById("result");
      resultElem.innerHTML = "Submitted! Please check the console for the transaction hash.";
      var xhr = new XMLHttpRequest();
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          alert(xhr.response);
        }
      }
      xhr.open('POST', 'http://localhost:${randomPort}/result', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
  
      // send request
      xhr.send(JSON.stringify({ signature: result }));
      console.log('decoded qr code:', result);
    });
    qrScanner.start();
  });
</script>
<h1>Scan the QR code below.</h1>
<image src=${dataUrl} />
<br />
<h1>Show the QR code of the signed transaction that is displayed on your Signer device.</h1>
<video id="video" width="300" height="300"></video>
<p id="result">No code seen, please center the QR code in the screen.</p>
<p id="polkascan"></p>
    `);
  });
  let lock = false;
  app.post("/result", async (req, res) => {
    if (lock) return;
    lock = true;
    call.addSignature(address, '0x' + req.body.signature, payload.toPayload());
    // console.log("Signed transaction:", call.toJSON() + "\n");
    const hash = await call.send();
    console.log("Hash:", hash.toString());

    res.end(`https://polkascan.io/kusama/transaction/${hash.toString()}`);
    process.exit(0);
  });

  const server = app.listen(randomPort);
  opn(`http://localhost:${randomPort}`)
};

program
  .command("payout")
  .option("--address <signer>", "The address of the signer of the transactions.", "")
  .option("--csv <dot_address>", "The CSV files with the Polkadot addresses to pay out.", "")
  .option("--final", "Set the script to use `as_multi` instead `approve_as_multi`.")
  .option("--otherSigners <[addr1,addr2,..>", "Comma-separated list of accounts that are other signers of the Msig.", "")
  .option("--threshold <number>", "The threshold of signers for the MultiSig.", "1")
  .option("--wsEndpoint <url>", "The WebSockets endpoint to connect.", "wss://rpc.polkadot.io")
  .action(payout);

program
  .command("scanAddress")
  .description("Scans a Parity Signer address and prints it to the CLI for input into signing scripts.")
  .action(scanAddress);

program.parse(process.argv);
