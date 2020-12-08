"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLicenseKey = exports.fetchLinkedAccounts = exports.cloudServiceIntegrationMutation = exports.cloudLinkAccountMutation = exports.nerdgraphFetch = void 0;
const node_fetch_1 = require("node-fetch");
exports.nerdgraphFetch = (apiKey, region, query) => __awaiter(void 0, void 0, void 0, function* () {
    const gqlUrl = region.includes("eu")
        ? "https://api.newrelic.com/graphql"
        : "https://api.newrelic.com/graphql";
    const res = yield node_fetch_1.default(gqlUrl, {
        body: JSON.stringify({ query }),
        headers: {
            "API-Key": apiKey,
            "Content-Type": "application/json"
        },
        method: "POST"
    });
    return res.json();
});
exports.cloudLinkAccountMutation = (accountId, roleArn, linkedAccount) => `
  mutation {
    cloudLinkAccount(accountId: ${accountId}, accounts: {aws: [{arn: "${roleArn}", name: "${linkedAccount}"}]}) {
      linkedAccounts {
        id
        name
      }
      errors {
          message
      }
    }
  }
`;
exports.cloudServiceIntegrationMutation = (accountId, provider, service, linkedAccountId) => `
  mutation {
    cloudConfigureIntegration (
      accountId: ${accountId},
      integrations: {${provider}: {${service}: {linkedAccountId: ${linkedAccountId}}}}
    ) {
      integrations {
        id
        name
        service {
          id
          name
        }
      }
      errors {
        linkedAccountId
        message
      }
    }
  }
`;
exports.fetchLinkedAccounts = (accountId) => `
  query {
    actor {
      account(id: ${accountId}) {
        cloud {
          linkedAccounts {
            id
            name
            createdAt
            updatedAt
            authLabel
            externalId
            nrAccountId
          }
        }
      }
    }
  }
`;
exports.fetchLicenseKey = (accountId) => `
  {
    actor {
      account(id: ${accountId}) {
        licenseKey
        name
        id
      }
    }
  }
`;
