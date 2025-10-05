import { Socket } from "../node_modules/socket.io-client/build/esm/index";
import { io } from "../node_modules/socket.io-client/build/esm/index";

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

type MultipleChoiceMemoryEntry = {
    question: string
    correctChoice: string
    possibleChoices: string[]
}

type IconPositionEntry = {
    x: number
    y: number
}

const CHOICE_X = 460;
const CHOICE_Y_START = 364;
const CHOICE_Y_INTERVAL = 56;

function isUseless(str: string) {
    if (!str) return true; // null, undefined, or empty string

    // Remove whitespace, newlines, tabs
    const cleaned = str.replace(/\s+/g, '');

    // Check for specific "useless" words
    const uselessWords = ["string"];
    if (uselessWords.includes(cleaned.toLowerCase())) return true;

    // If nothing meaningful left, consider it useless
    return cleaned.length === 0;
}

function getElementScreenCoordinates(el: HTMLElement) {
    // Get the element's bounding box relative to the viewport
    const rect = el.getBoundingClientRect();

    // Browser window's position on the screen
    const screenX = window.screenX ?? window.screenLeft;
    const screenY = window.screenY ?? window.screenTop;

    // Window chrome offset (browser UI like tabs, toolbars)
    const chromeX = window.outerWidth - window.innerWidth;
    const chromeY = window.outerHeight - window.innerHeight;

    // Scroll offsets
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    // Compute the absolute screen coordinates
    const x = rect.left + screenX + (chromeX / 2) + scrollX;
    const y = rect.top + screenY + chromeY - scrollY; // some browsers include toolbar height in outerHeight

    return { x, y };
}

function arraysSameSet(a: any[], b: any[]) {
    return new Set(a).size === new Set(b).size &&
        [...new Set(a)].every(val => new Set(b).has(val));
}

function cleanString(s: string) {
    return s.replace(/[\n\t]/g, ""); // remove newlines and tabs
}

class App {

    private socket!: Socket;
    private addr: string;
    private questionWrapper: HTMLDivElement | null = null;
    private multipleChoiceMemory: MultipleChoiceMemoryEntry[] = [];
    private imageMemory: { [key: string]: string } = {}; // Will store the image to the specific URL
    private blurbMemory: Set<string> = new Set();
    private knownWordsInList: Set<string> = new Set();

    constructor(addr: string = "ws://127.0.0.1:5000") {
        this.addr = addr;

        this.m_initialize();
        //this.m_testLoop();
    }

    private emitAsync(event: any, data: any) {
        return new Promise((resolve) => {
            this.socket.emit(event, data, (response: any) => {
                resolve(response);
            });
        });
    }

    private m_isMultipleChoiceQuestionInMemory(question: string, choices: string[]) {
        // New implementation allows for multiple memories, same instruction
        for (const memory of this.multipleChoiceMemory) {
            if (memory.question != question) continue;
            if (!arraysSameSet(choices, memory.possibleChoices)) continue;
            return memory.correctChoice;
        }

    }

    private m_addMultipleChoiceMemory(question: string, choices: string[], correctChoice: string) {
        if (this.m_isMultipleChoiceQuestionInMemory(question, choices) != null) return;
        this.multipleChoiceMemory.push({ question: question, possibleChoices: choices, correctChoice: correctChoice });
    }

    private m_deleteMultipleChoiceFromMemory(question: string, choices: string[]) {
        let i = -1;
        for (const memory of this.multipleChoiceMemory) {
            i++;
            if (memory.question != question) continue;
            if (!arraysSameSet(choices, memory.possibleChoices)) continue;
            this.multipleChoiceMemory.splice(i, 1);
            return;

        }
    }


    private async m_getQuestionWrapper() {

        const questionPane = document.querySelector(".questionPane") as HTMLDivElement | null;

        if (questionPane == null) {
            throw new Error("Page has no .questionPane");
        }

        const lastChild = questionPane.lastElementChild;
        if (lastChild == null) {
            throw new Error(".questionPane has no lastChild");
        }

        this.questionWrapper = lastChild as HTMLDivElement;

        this.questionWrapper.style.backgroundColor = 'red';
    }

    private async m_getIconPositions(): Promise<IconPositionEntry[]> {
        return await this.emitAsync("locateChoices", null) as IconPositionEntry[];
    }
    private async m_getSimilarities(target: string, words: string[]) {
        return await this.emitAsync("similarity", { target: target, words: words }) as number[];
    }

    private async m_click(data: { x: number, y: number }) {
        await this.emitAsync("click", { x: data.x, y: data.y });
    }

    private m_isCorrect() {
        if (!this.questionWrapper) throw new Error("No question wrapper");
        const statusElement: HTMLDivElement | null = this.questionWrapper.querySelector(".status");

        if (!statusElement) throw new Error("No status");

        if (statusElement.classList.contains("correct") == true) return true;
        return false;
    }

    private async m_getSimilaritiesOrRandom(targetWord: string | null, choices: string[]) {
        if (!targetWord) {
            const list = [];
            for (const choice of choices) {
                list.push(Math.random());
            }
            console.warn("Picked random similarities")
            return list;
        } else {

            // Clean the answers

            const targetCleaned = cleanString(targetWord);
            const choicesCleaned = [];

            for (const choice of choices) {
                choicesCleaned.push(cleanString(choice));
            }

            return await this.m_getSimilarities(targetCleaned, choicesCleaned);
        }
    }

    private m_boostKnownWords(probabilityList: number[], wordList: string[]) {
        
        // Boost probability for words known to be in the list for fill in the blank.

        const newProbList = [];
        let index= 0 ;
        for (const word of wordList) {
            
            const prob = probabilityList[index];
            if (prob == null) {
                console.error("No probability at index: ", index, " probability list: ", probabilityList);
                return;
            };
            if (this.knownWordsInList.has(cleanString(word).toLowerCase())) {
                newProbList.push(prob * 2.5); // Boost probability if we think word is in the list
            } else {
                newProbList.push(prob);
            }
            index++;
        }

        return newProbList;
    }

    private async m_tryChoices() {
        if (!this.questionWrapper) return;
        const choicesElement: HTMLDivElement | null = this.questionWrapper.querySelector(".choices");
        const questionElement: HTMLDivElement | null = this.questionWrapper.querySelector(".questionContent");
        const instructionsElement: HTMLDivElement | null = this.questionWrapper.querySelector(".instructions");

        if (!choicesElement || !questionElement || !instructionsElement) throw new Error("Missing elements");

        const choices = Array.from(choicesElement.children) as HTMLAnchorElement[];
        const questionContent = questionElement.textContent + instructionsElement.textContent;;

        let targetWord = null;
        const targetWordElement = instructionsElement.querySelector("strong")
        if (targetWordElement) {
            targetWord = targetWordElement.textContent;
            this.knownWordsInList.add(cleanString(targetWord).toLowerCase());
        }



        console.log("Question is: ", questionContent);

        // Do we already know the answer?


        //await this.m_click({ x: 100, y: 100 });
        //await wait(1000);


        // Get the possible answers

        let possibleAnswers: string[] = [];

        for (const choice of choices) {
            possibleAnswers.push(choice.textContent);
        }

        const memorized = this.m_isMultipleChoiceQuestionInMemory(questionContent, possibleAnswers);
        if (memorized) {
            // We already know the answer

            let index = 0;

            const iconPositions = await this.m_getIconPositions();

            for (const choice of choices) {
                if (memorized == choice.textContent) {
                    console.log("Answer memorized");
                    // Where choice is a anchor element
                    // We need to get the position on screen in the whole screen (not just web viewport)


                    const p = iconPositions[index];
                    if (!p) return;

                    await this.m_click({ x: p.x, y: p.y });

                    await wait(1000);

                    if (this.m_isCorrect() == false) {
                        this.m_deleteMultipleChoiceFromMemory(questionContent, possibleAnswers);
                    }

                    return;
                }

                index++;
            }

            this.m_deleteMultipleChoiceFromMemory(questionContent, possibleAnswers);
        } else {
            // We're forced to make a guess based on similarity

            //const iconPositions = await this.m_getIconPositions();

            const sentenceElement = questionElement.querySelector(".sentence");
            let sentence = null;
            if (sentenceElement && sentenceElement.textContent.includes("_")) sentence = cleanString(sentenceElement.textContent); // No fill-in the blank right now

            const similarities_unprocessed = await this.m_getSimilaritiesOrRandom(sentence || targetWord, possibleAnswers);

            const similarities = this.m_boostKnownWords(similarities_unprocessed, possibleAnswers);
            if (!similarities) throw new Error("Failed to perform post-process of similarities");

            const scored: { answer: string; score: number }[] = possibleAnswers.map((answer, i) => ({
                answer,
                score: similarities[i]!, // non-null assertion
            }));

            const sorted = scored
                .sort((a, b) => b.score - a.score)
                .map(x => x.answer);
            


            let index = 0;
            for (const answer of sorted) {
                for (const choice of choices) {
                    if (choice.textContent != answer) continue;
                    console.log("Guess");   
                    //const p = iconPositions[index];
                    //if (!p) return;

                    const screenCoords = getElementScreenCoordinates(choice);

                    await this.m_click({ x: screenCoords.x + 10, y: screenCoords.y + 10 });
                    await wait(1000);
                    //this.socket.emit("click", { x: screenCoords.x + 10, y: screenCoords.y + 10 });

                    //await wait(1000);

                    if (this.m_isCorrect()) {
                        console.log("Is correct");

                        this.m_addMultipleChoiceMemory(questionContent, possibleAnswers, choice.textContent);
                        return;
                    }
                    index++;
                }


            }


        }

    }

    private m_isSpelling() {
        if (!this.questionWrapper) return false;
        return this.questionWrapper.querySelector(".spellit") != null;
    }

    private m_isImageQuestion() {
        if (!this.questionWrapper) return false;
        return this.questionWrapper.querySelector(".typeI") != null;
    }

    private async m_solveImageQuestion() {
        if (!this.questionWrapper) return;

        // Test

        const wordElement: HTMLDivElement | null = this.questionWrapper.querySelector(".word");

        if (!wordElement) return;

        //const coords = getElementScreenCoordinates(wordElement);

        //this.socket.emit("click", {x: coords.x, y: coords.y});

        const choicesElement: HTMLDivElement | null = this.questionWrapper.querySelector(".choices");
        if (!choicesElement) return;

        if (this.imageMemory[wordElement.textContent] == null) {
            // Guess and remember
            for (const choice of choicesElement.children) {
                const style = (choice as HTMLElement).style.backgroundImage;
                const coords = getElementScreenCoordinates(choice as HTMLElement);

                await this.m_click({ x: coords.x + 50, y: coords.y + 50 });
                await wait(1000);

                if (this.m_isCorrect() == true) {
                    this.imageMemory[wordElement.textContent] = style;
                    return;
                }
            }
        } else {
            // Use already remembered answer

            const appropriateStyle = this.imageMemory[wordElement.textContent];

            for (const choice of choicesElement.children) {
                const style = (choice as HTMLElement).style.backgroundImage;
                if (appropriateStyle == style) {
                    const coords = getElementScreenCoordinates(choice as HTMLElement);
                    await this.m_click({ x: coords.x + 50, y: coords.y + 50 });
                    await wait(1000);
                    if (this.m_isCorrect() == false) {
                        delete this.imageMemory[wordElement.textContent]; // Delete bad memory
                    }
                    return;
                }
            }

            // Nothing found, bad image memory delete

            delete this.imageMemory[wordElement.textContent];
        }



        await wait(100000);
    }

    private async m_solveSpelling() {
        if (!this.questionWrapper) return;

        await this.m_click({ x: 100, y: 100 }) // Move mouse out of the way to prevent it from hiding recognition
        await wait(1000);

        // Yes! Apparently, they conveniently left out a completed sentence element where the word is in <strong> tags.

        const completedSentenceElement = this.questionWrapper.querySelector(".complete");
        if (!completedSentenceElement) throw new Error("No completed sentence elemnt");
        const theWord = completedSentenceElement.querySelector("strong");
        if (!theWord) throw new Error("No STRONG");

        console.log("Spelling word is: ", theWord.textContent);

        // Locate the spell button

        const playButtons = await this.emitAsync("locateSpell", null) as IconPositionEntry[];
        const spellButtons = await this.emitAsync("locateSpellButton", null) as IconPositionEntry[];

        // Only consider the first one because too lazy

        const typeCoords = playButtons[0];
        const spellCoords = spellButtons[0];
        if (!typeCoords) throw new Error("No play button found");
        if (!spellCoords) throw new Error("No spell button found");

        await this.m_click({ x: typeCoords.x + 50, y: typeCoords.y });
        await wait(1000);
        this.socket.emit("type", theWord.textContent);



        await wait(theWord.textContent.length * 100);

        await this.m_click({ x: spellCoords.x, y: spellCoords.y });
        await wait(1000);
        //spellit
    }

    private async m_clickNext() {
        const nextButton: HTMLButtonElement | null = document.querySelector('[aria-label="Next question"]');
        if (!nextButton) return;
        const nextButtonSpan: HTMLSpanElement | null = nextButton.querySelector("span");
        if (!nextButtonSpan) return;

        const screenCoords = getElementScreenCoordinates(nextButtonSpan);
        await this.m_click({x: screenCoords.x, y: screenCoords.y});

        //nextButton.click();
    }

    private m_isSummaryScreen() {
        if (!this.questionWrapper) return false;
        return this.questionWrapper.querySelector(".roundSummary") != null;
    }
    private m_isAchievementScreen() {
        if (!this.questionWrapper) return false;
        return this.questionWrapper.querySelector(".hero") != null;
    }

    private m_rememberBlurb() {
        if (!this.questionWrapper) return;
        if (this.m_isCorrect() == false) return;

        const blurb = this.questionWrapper.querySelector(".blurb");
        if (!blurb) throw new Error("No blurb");

        this.blurbMemory.add(blurb.textContent);
    }

    private async m_botLoop() {
        while (true) {
            await wait(500);
            await this.m_getQuestionWrapper();
            if (this.m_isSummaryScreen()) {
                await wait(2000);
                await this.m_clickNext();
                continue;
            }

            if (this.m_isSpelling()) {
                console.log("IT IS A SPELLING THING")
                await this.m_solveSpelling();
                await wait(2000);
                await this.m_clickNext();
                continue;
            }

            if (this.m_isImageQuestion()) {
                await this.m_solveImageQuestion();
                await wait(2000);
                await this.m_clickNext();
                continue;
            }

            if (this.m_isAchievementScreen()) {
                console.log("IS ACHIEVEMENT SCREEN");
                await wait(2000);
                await this.m_clickNext();
                continue;
            }
            await this.m_getQuestionWrapper();
            await this.m_tryChoices();
            await wait(2000);
            if (this.m_isCorrect()) {
                this.m_rememberBlurb();
                await this.m_clickNext();
            }

            await wait(1000);
        }
    }

    private async m_initialize() {
        this.m_connectToServer();
        await wait(2000);
        this.m_getQuestionWrapper();
        this.m_botLoop();
    }

    private async m_connectToServer() {
        try {
            this.socket = io(this.addr);
        } catch (err) {
            console.error("Failed to connect to server: ", err);
            alert(`Failed to connect to the server: ${err}`);

            throw new Error("Failed to connect to the server");
        }

    }

}

function onLoad() {
    console.log("Loading app successfully!");

    try {
        const app: App = new App();
    } catch (error) {
        console.error("Failed to initialize: ", error);
        alert("Failed to initialize");
    }


}

window.onload = onLoad;