
let shouldConfirmAutomatically = false;
const originalConfirm = window.confirm;

function overwriteConfirm() {
    window.confirm = (message) => {
        if (shouldConfirmAutomatically) return true;
        return originalConfirm(message);
    }
}

function registerEvents() {
    window.addEventListener("message", (event) => {
        if (event.source !== window) {
            console.warn("ignore event: untrusted source");
            return;
        }

        if (event.data.type == "ENABLE_CONFIRM") {
            console.log("set flag confirm = true");
            shouldConfirmAutomatically = true;
        }
        if (event.data.type == "DISABLE_CONFIRM") {
            console.log("set flag confirm = false");
            shouldConfirmAutomatically = false;
        }
    })
}

function initialize() {
    overwriteConfirm();
    registerEvents();
}

initialize();