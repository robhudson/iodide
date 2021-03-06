import { postMessageToEditor } from "../port-to-editor";
import {
  appendToEvalHistory,
  updateValueInHistory,
  sendStatusResponseToEditor
} from "./actions";
import generateRandomId from "../../tools/generate-random-id";

export function addLanguage(languageDefinition) {
  return {
    type: "ADD_LANGUAGE_TO_EVAL_FRAME",
    languageDefinition
  };
}

function loadLanguagePlugin(pluginData, historyId, dispatch) {
  let value;
  let languagePluginPromise;

  if (pluginData.url === undefined) {
    value = 'plugin definition missing "url"';
    dispatch(updateValueInHistory(historyId, value));
  } else {
    const { url, displayName } = pluginData;

    languagePluginPromise = new Promise((resolve, reject) => {
      const xhrObj = new XMLHttpRequest();

      xhrObj.addEventListener("progress", evt => {
        value = `downloading plugin: ${evt.loaded} bytes loaded`;
        if (evt.total > 0) {
          value += `out of ${evt.total} (${evt.loaded / evt.total}%)`;
        }
        dispatch(updateValueInHistory(historyId, value));
      });

      xhrObj.addEventListener("load", () => {
        value = `${displayName} plugin downloaded, initializing`;
        dispatch(updateValueInHistory(historyId, value));
        // see the following for asynchronous loading of scripts from strings:
        // https://developer.mozilla.org/en-US/docs/Games/Techniques/Async_scripts

        window.languagePluginUrl = url;

        if (xhrObj.status > 400 && xhrObj.status < 600) {
          value = `${displayName} failed to load: ${xhrObj.status} ${
            xhrObj.statusText
          }`;
          dispatch(updateValueInHistory(historyId, value));
          resolve();
        }

        // Here, we wrap whatever the return value of the eval into a promise.
        // If it is simply evaling a code block, then it returns undefined.
        // But if it returns a Promise, then we can wait for that promise to resolve
        // before we continue execution.
        const pr = Promise.resolve(window.eval(xhrObj.responseText)); // eslint-disable-line no-eval

        pr.then(() => {
          value = `${displayName} plugin ready`;
          dispatch(addLanguage(pluginData));
          postMessageToEditor("POST_LANGUAGE_DEF_TO_EDITOR", pluginData);
          dispatch(updateValueInHistory(historyId, value));
          delete window.languagePluginUrl;
          resolve();
        }).catch(err => {
          dispatch(updateValueInHistory(historyId, err));
          reject(err);
        });
      });

      xhrObj.addEventListener("error", () => {
        value = `${displayName} plugin failed to load`;
        dispatch(updateValueInHistory(historyId, value));
        reject();
      });

      xhrObj.open("GET", url, true);
      xhrObj.send();
    });
  }
  return languagePluginPromise;
}

export function evaluateLanguagePlugin(pluginText, evalId) {
  return dispatch => {
    const historyId = generateRandomId();
    dispatch(
      appendToEvalHistory(null, pluginText, undefined, {
        historyId,
        historyType: "CELL_EVAL_INFO"
      })
    );

    let pluginData;
    try {
      pluginData = JSON.parse(pluginText);
    } catch (err) {
      dispatch(
        updateValueInHistory(
          historyId,
          `plugin definition failed to parse:\n${err.message}`
        )
      );
      sendStatusResponseToEditor("ERROR", evalId);
      return Promise.reject();
    }
    return loadLanguagePlugin(pluginData, historyId, dispatch)
      .then(() => {
        sendStatusResponseToEditor("SUCCESS", evalId);
      })
      .catch(err => {
        sendStatusResponseToEditor("ERROR", evalId);
        return err;
      });
  };
}

export function ensureLanguageAvailable(languageId, state, dispatch) {
  if (Object.prototype.hasOwnProperty.call(state.loadedLanguages, languageId)) {
    return new Promise(resolve => resolve(state.loadedLanguages[languageId]));
  }

  if (
    Object.prototype.hasOwnProperty.call(state.languageDefinitions, languageId)
  ) {
    const historyId = generateRandomId();
    dispatch(
      appendToEvalHistory(
        null,
        `Loading ${
          state.languageDefinitions[languageId].displayName
        } language plugin`,
        undefined,
        { historyId, historyType: "CELL_EVAL_INFO" }
      )
    );
    return loadLanguagePlugin(
      state.languageDefinitions[languageId],
      historyId,
      dispatch
    ).then(() => state.languageDefinitions[languageId]);
  }
  // There is neither a loaded language or a predefined definition that matches...
  // FIXME: It would be hard to get here in the UX, but with direct JSMD
  // editing you could...
  return new Promise((resolve, reject) => reject());
}

export function runCodeWithLanguage(language, code, messageCallback) {
  const { module, evaluator, asyncEvaluator } = language;
  if (asyncEvaluator !== undefined) {
    const messageCb =
      messageCallback === undefined ? () => {} : messageCallback;
    try {
      return window[module][asyncEvaluator](code, messageCb);
    } catch (e) {
      if (e.message === "window[module] is undefined") {
        return new Error(
          `Error evaluating ${
            language.displayName
          }; evaluation module "${module}" not not defined`
        );
      }
      return e;
    }
  }
  return new Promise((resolve, reject) => {
    try {
      resolve(window[module][evaluator](code));
    } catch (e) {
      reject(e);
    }
  });
}
