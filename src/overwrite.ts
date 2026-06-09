
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
    
    // 1. Target the element you want to watch
    const targetClass = '.blocker';

    console.log(`[Script Started] Watching for ${targetClass} to appear...`);

    // 2. Setup the observer to watch the entire page
    const observer = new MutationObserver((mutations, obs) => {
        const element = document.querySelector(targetClass);
        
        if (element) {
            console.log(`[Found] ${targetClass} detected! Refreshing page...`);
            // Disconnect observer before reloading to free up memory
            obs.disconnect(); 
            // Refresh the page
            window.location.reload();
        }
    });

    // 3. Start observing the document body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
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