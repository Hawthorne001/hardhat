import uniq from "lodash/uniq";

import { IgnitionError } from "../../../errors";
import {
  isArtifactContractAtFuture,
  isEncodeFunctionCallFuture,
  isNamedContractAtFuture,
  isReadEventArgumentFuture,
} from "../../../type-guards";
import {
  Future,
  IgnitionModule,
  IgnitionModuleResult,
} from "../../../types/module";
import { ERRORS } from "../../errors-list";
import { getFuturesFromModule } from "../../utils/get-futures-from-module";
import { getPendingOnchainInteraction } from "../../views/execution-state/get-pending-onchain-interaction";
import { resolveFutureFrom } from "../future-processor/helpers/future-resolvers";
import { JsonRpcClient } from "../jsonrpc-client";
import { DeploymentState } from "../types/deployment-state";
import { ExecutionStateType, ExecutionStatus } from "../types/execution-state";
import {
  JournalMessageType,
  OnchainInteractionDroppedMessage,
  OnchainInteractionReplacedByUserMessage,
} from "../types/messages";

/**
 * This function is meant to be used to sync the local state's nonces
 * with those of the network.
 *
 * This function has three goals:
 *  - Ensure that we never proceed with Ignition if there are transactions
 *    sent by the user that haven't got enough confirmations yet.
 *  - Detect if the user has replaced a transaction sent by Ignition.
 *  - Distinguish if a transaction not being present in the mempool was
 *    dropped or replaced by the user.
 *
 * The way this function works means that there's one case we don't handle:
 *  - If the user replaces a transaction sent by Ignition with one of theirs
 *    we'll allocate a new nonce for our transaction.
 *  - If the user's transaction gets dropped, we won't reallocate the original
 *    nonce for any of our transactions, and Ignition will eventually fail,
 *    setting one or more ExecutionState as TIMEOUT.
 *  - This is intentional, as reusing user nonces can lead to unexpected
 *    results.
 *  - To understand this better, please consider that a transaction being
 *    dropped by your node doesn't mean that the entire network forgot about it.
 *
 * @param jsonRpcClient The client used to interact with the network.
 * @param deploymentState The current deployment state, which we want to sync.
 * @param requiredConfirmations The amount of confirmations that a transaction
 *  must have before we consider it confirmed.
 * @returns The messages that should be applied to the state.
 */
export async function getNonceSyncMessages(
  jsonRpcClient: JsonRpcClient,
  deploymentState: DeploymentState,
  ignitionModule: IgnitionModule<string, string, IgnitionModuleResult<string>>,
  accounts: string[],
  defaultSender: string,
  requiredConfirmations: number
): Promise<
  Array<
    OnchainInteractionReplacedByUserMessage | OnchainInteractionDroppedMessage
  >
> {
  const messages: Array<
    OnchainInteractionReplacedByUserMessage | OnchainInteractionDroppedMessage
  > = [];

  const pendingTransactionsPerSender =
    createMapFromSenderToNonceAndTransactions(
      deploymentState,
      ignitionModule,
      accounts,
      defaultSender
    );

  const block = await jsonRpcClient.getLatestBlock();
  const confirmedBlockNumber: number | undefined =
    block.number - requiredConfirmations + 1 >= 0
      ? block.number - requiredConfirmations + 1
      : undefined;

  for (const [sender, pendingIgnitionTransactions] of Object.entries(
    pendingTransactionsPerSender
  )) {
    // If this is undefined, it means that no transaction has fully confirmed.
    const safeConfirmationsCount =
      confirmedBlockNumber !== undefined
        ? await jsonRpcClient.getTransactionCount(sender, confirmedBlockNumber)
        : undefined;

    const pendingCount = await jsonRpcClient.getTransactionCount(
      sender,
      "pending"
    );

    const latestCount = await jsonRpcClient.getTransactionCount(
      sender,
      "latest"
    );

    // Is the pending count the same as the safe count (x confirmation blocks
    // in the past), then all pending transactions have been safely confirmed.
    // There is one other case, where the current block is so low, we
    // can't have enough confirmations (i.e. block 2 when confirmations required
    // is 5). In that case all pending onchain transactions are unconfirmed.
    const hasOnchainUnconfirmedPendingTransactions =
      safeConfirmationsCount === undefined
        ? pendingCount > 0
        : safeConfirmationsCount !== pendingCount;

    // Case 0: We don't have any pending Ignition transactions
    if (pendingIgnitionTransactions.length === 0) {
      if (hasOnchainUnconfirmedPendingTransactions) {
        throw new IgnitionError(ERRORS.EXECUTION.WAITING_FOR_CONFIRMATIONS, {
          sender,
          requiredConfirmations,
        });
      }
    }

    for (const {
      nonce,
      transactions,
      executionStateId,
      networkInteractionId,
    } of pendingIgnitionTransactions) {
      const fetchedTransactions = await Promise.all(
        transactions.map((tx) => jsonRpcClient.getTransaction(tx))
      );

      // If at least one transaction for the future is still in the mempool,
      // we do nothing
      if (fetchedTransactions.some((tx) => tx !== undefined)) {
        continue;
      }

      // If we are here, all the previously pending transactions for this
      // future were dropped or replaced.

      // Case 1: Confirmed transaction with this nonce
      // There are more transactions up to the latest block than our nonce,
      // that means that one transaction with our nonce was sent and confirmed
      //
      // Example:
      //
      // Ignition sends transaction with nonce 5
      // It is replaced by the user, with user transaction nonce 5
      // The user transaction confirms
      // That means there is a block that includes it
      // If we look at the latest transaction count, it will be at least 6
      if (latestCount > nonce) {
        const hasEnoughConfirmations =
          safeConfirmationsCount !== undefined &&
          safeConfirmationsCount >= nonce;

        // We know the ignition transaction was replaced, and the replacement
        // transaction has at least one confirmation.
        // We don't continue until the user's transactions have enough confirmations
        if (!hasEnoughConfirmations) {
          throw new IgnitionError(ERRORS.EXECUTION.WAITING_FOR_NONCE, {
            sender,
            nonce,
            requiredConfirmations,
          });
        }

        messages.push({
          type: JournalMessageType.ONCHAIN_INTERACTION_REPLACED_BY_USER,
          futureId: executionStateId,
          networkInteractionId,
        });

        continue;
      }

      // Case 2: There's a pending transaction with this nonce sent by the user

      // We first handle confirmed transactions, that'w why this check is safe here
      //
      // Example:
      //
      // Ignition has sent a transaction with nonce 5
      // It is replaced by the user, with user transaction nonce 5
      // The user transaction is still in the mempool
      // The pending count will show as larger than the nonce, and we know
      // from the test above that it has not been confirmed
      if (pendingCount > nonce) {
        throw new IgnitionError(ERRORS.EXECUTION.WAITING_FOR_NONCE, {
          sender,
          nonce,
          requiredConfirmations,
        });
      }

      // Case 3: There's no transaction sent by the user with this nonce, but ours were still dropped
      messages.push({
        type: JournalMessageType.ONCHAIN_INTERACTION_DROPPED,
        futureId: executionStateId,
        networkInteractionId,
      });
    }

    // Case 4: the user sent additional transactions with nonces higher than
    // our highest pending nonce.
    const highestPendingNonce = Math.max(
      ...pendingIgnitionTransactions.map((t) => t.nonce)
    );

    if (highestPendingNonce + 1 < pendingCount) {
      // If they have enough confirmation we continue, otherwise we throw
      // and wait for further confirmations
      if (hasOnchainUnconfirmedPendingTransactions) {
        throw new IgnitionError(ERRORS.EXECUTION.WAITING_FOR_NONCE, {
          sender,
          nonce: pendingCount - 1,
          requiredConfirmations,
        });
      }
    }
  }

  return messages;
}

function createMapFromSenderToNonceAndTransactions(
  deploymentState: DeploymentState,
  ignitionModule: IgnitionModule<string, string, IgnitionModuleResult<string>>,
  accounts: string[],
  defaultSender: string
): {
  [sender: string]: Array<{
    nonce: number;
    transactions: string[];
    executionStateId: string;
    networkInteractionId: number;
  }>;
} {
  const pendingTransactionsPerAccount: {
    [sender: string]: Array<{
      nonce: number;
      transactions: string[];
      executionStateId: string;
      networkInteractionId: number;
    }>;
  } = {};

  for (const executionState of Object.values(deploymentState.executionStates)) {
    if (
      executionState.type ===
        ExecutionStateType.READ_EVENT_ARGUMENT_EXECUTION_STATE ||
      executionState.type === ExecutionStateType.CONTRACT_AT_EXECUTION_STATE ||
      executionState.type ===
        ExecutionStateType.ENCODE_FUNCTION_CALL_EXECUTION_STATE
    ) {
      continue;
    }

    if (executionState.status === ExecutionStatus.SUCCESS) {
      continue;
    }

    const onchainInteraction = getPendingOnchainInteraction(executionState);

    if (onchainInteraction === undefined) {
      continue;
    }

    if (onchainInteraction.nonce === undefined) {
      continue;
    }

    if (pendingTransactionsPerAccount[executionState.from] === undefined) {
      pendingTransactionsPerAccount[executionState.from] = [];
    }

    pendingTransactionsPerAccount[executionState.from].push({
      nonce: onchainInteraction.nonce,
      transactions: onchainInteraction.transactions.map((tx) => tx.hash),
      executionStateId: executionState.id,
      networkInteractionId: onchainInteraction.id,
    });
  }

  const exStateIds = Object.keys(deploymentState.executionStates);
  const futureSenders = _resolveFutureSenders(
    ignitionModule,
    accounts,
    defaultSender,
    exStateIds
  );

  for (const futureSender of futureSenders) {
    if (pendingTransactionsPerAccount[futureSender] === undefined) {
      pendingTransactionsPerAccount[futureSender] = [];
    }
  }

  for (const pendingTransactions of Object.values(
    pendingTransactionsPerAccount
  )) {
    pendingTransactions.sort((a, b) => a.nonce - b.nonce);
  }

  return pendingTransactionsPerAccount;
}

/**
 * Scan the futures for upcoming account usage, add them to the list,
 * including the default sender if there are any undefined forms
 */
function _resolveFutureSenders(
  ignitionModule: IgnitionModule<string, string, IgnitionModuleResult<string>>,
  accounts: string[],
  defaultSender: string,
  exStateIds: string[]
): string[] {
  const futures = getFuturesFromModule(ignitionModule);

  const senders: string[] = futures
    .filter((f) => !exStateIds.includes(f.id))
    .map((f) => _pickFrom(f, accounts, defaultSender))
    .filter((x): x is string => x !== null);

  return uniq(senders);
}

function _pickFrom(
  future: Future,
  accounts: string[],
  defaultSender: string
): string | null {
  if (isNamedContractAtFuture(future)) {
    return null;
  }

  if (isArtifactContractAtFuture(future)) {
    return null;
  }

  if (isReadEventArgumentFuture(future)) {
    return null;
  }

  if (isEncodeFunctionCallFuture(future)) {
    return null;
  }

  return resolveFutureFrom(future.from, accounts, defaultSender);
}
