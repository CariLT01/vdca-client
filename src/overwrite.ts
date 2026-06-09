
let shouldConfirmAutomatically = false;
const originalConfirm = window.confirm;

function overwriteConfirm() {
    window.confirm = (message) => {
        if (shouldConfirmAutomatically) return true;
        return originalConfirm(message);
    }

    /* 
    In vocabulary.com, alert() is only triggered when the game
    goes into an error state. Therefore, refresh the page after
    1 second if window.alert() ever gets called.

    Error states occur for many reasons, including from bot
    detection or when one game is played in multiple locations
    (determined with IP address?)
    */
    window.alert = (message) => {
        console.log("Window alert got message: ", message);
        setTimeout(() => {
            window.location.reload();
        }, 1000);
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