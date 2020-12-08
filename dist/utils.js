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
exports.fetchPolicy = exports.waitForStatus = void 0;
const fs = require("fs-extra");
const _ = require("lodash");
const path = require("path");
exports.waitForStatus = (requestParams, serverlessProps, retryCount = 0) => __awaiter(void 0, void 0, void 0, function* () {
    const { awsProvider, serverless } = serverlessProps;
    const { awsMethod, callbackMethod, methodParams, statusPath } = requestParams;
    try {
        const resourceStatus = yield awsProvider.request("CloudFormation", awsMethod, methodParams);
        const status = _.get(resourceStatus, statusPath);
        if (status.includes("FAILED") || retryCount > 120) {
            throw new Error();
        }
        else if (status === "CREATE_COMPLETE") {
            serverless.cli.log("Resource successfully created.");
            callbackMethod();
            return;
        }
        setTimeout(() => exports.waitForStatus(requestParams, serverlessProps, retryCount + 1), 30000);
    }
    catch (stackErr) {
        serverless.cli.log(`Something went wrong while creating aws resource: ${stackErr}`);
    }
});
exports.fetchPolicy = (templatePolicy) => __awaiter(void 0, void 0, void 0, function* () {
    const policy = yield fs.readFile(path.resolve(__dirname, "..", "templates", templatePolicy), "utf-8");
    return policy;
});