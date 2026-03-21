// main.ts
function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type MultipleChoiceMemoryEntry = {
    question: string;
    correctChoice: string;
    possibleChoices: string[];
};

type IconPositionEntry = {
    x: number;
    y: number;
};

const CHOICE_X = 460;
const CHOICE_Y_START = 364;
const CHOICE_Y_INTERVAL = 56;

function isUseless(str: string) {
    if (!str) return true;
    const cleaned = str.replace(/\s+/g, "");
    const uselessWords = ["string"];
    if (uselessWords.includes(cleaned.toLowerCase())) return true;
    return cleaned.length === 0;
}

function getElementScreenCoordinates(el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const screenX = window.screenX ?? window.screenLeft;
    const screenY = window.screenY ?? window.screenTop;
    const chromeX = window.outerWidth - window.innerWidth;
    const chromeY = window.outerHeight - window.innerHeight;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const x = rect.left + screenX + chromeX / 2 + scrollX;
    const y = rect.top + screenY + chromeY - scrollY;
    return { x, y };
}

function arraysSameSet(a: any[], b: any[]) {
    return (
        new Set(a).size === new Set(b).size &&
        [...new Set(a)].every((val) => new Set(b).has(val))
    );
}

function cleanString(s: string) {
    return s.replace(/[\n\t]/g, "");
}

// ----- Background messaging helpers -----
type BgResponse = { ok: true; data?: any } | { ok: false; error: string };

function sendToBackground<T = any>(message: any): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response: unknown) => {
            // Check if lastError exists
            if ((chrome.runtime as any).lastError) {
                reject(new Error((chrome.runtime as any).lastError.message));
                return;
            }

            if (!response) {
                reject(new Error("No response from background"));
                return;
            }

            const resp = response as {
                ok?: boolean;
                error?: string;
                data?: any;
            };
            if (resp.ok === false) {
                reject(new Error(resp.error));
                return;
            }

            resolve((resp.data ?? resp) as T);
        });
    });
}

export class App {
    private questionWrapper: HTMLDivElement | null = null;
    private multipleChoiceMemory: MultipleChoiceMemoryEntry[] = [];
    private imageMemory: { [key: string]: string } = {};
    private blurbMemory: Set<string> = new Set();
    private knownWordsInList: Set<string> = new Set();
    private logBox: HTMLParagraphElement | null = null;
    private logContent: string = "";

    constructor() {
        this.m_initialize();
    }

    private emitAsync(event: string, data: any) {
        return sendToBackground({
            type: "socket:emit",
            requestId: crypto.randomUUID(),
            event,
            data,
        });
    }

    private async m_getQuestionWrapper() {
        const questionPane = document.querySelector(
            ".questionPane",
        ) as HTMLDivElement | null;
        if (!questionPane) throw new Error("Page has no .questionPane");
        const lastChild = questionPane.lastElementChild;
        if (!lastChild) throw new Error(".questionPane has no lastChild");
        this.questionWrapper = lastChild as HTMLDivElement;
    }

    private async m_getIconPositions(): Promise<IconPositionEntry[]> {
        return (await this.emitAsync(
            "locateChoices",
            null,
        )) as IconPositionEntry[];
    }

    private async m_getSimilarities(target: string, words: string[], word: string) {
        const probabilities: {[key: string]: number} = await this.emitAsync("similarity", {
            words: words,
            target: target,
            word: word
        })
        
        // align to original order
        const probabilities_array: number[] = [];
        for (const word of words) {
            console.log("word:", word.trim())
            console.log("prob:",probabilities[word.trim()])
            probabilities_array.push(probabilities[word.trim()]!);
        }

        console.log("probabilities:", probabilities_array);
        console.log("original: ", probabilities);

        return probabilities_array;
    }

    private async m_click(data: { x: number; y: number }) {
        await this.emitAsync("click", { x: data.x, y: data.y });
    }

    private m_isCorrect() {
        if (!this.questionWrapper) throw new Error("No question wrapper");
        const statusElement: HTMLDivElement | null =
            this.questionWrapper.querySelector(".status");
        if (!statusElement) throw new Error("No status");
        return statusElement.classList.contains("correct");
    }

    private m_isMultipleChoiceQuestionInMemory(
        question: string,
        choices: string[],
    ) {
        for (const memory of this.multipleChoiceMemory) {
            if (memory.question !== question) continue;
            if (!arraysSameSet(choices, memory.possibleChoices)) continue;
            return memory.correctChoice;
        }
    }

    private m_addMultipleChoiceMemory(
        question: string,
        choices: string[],
        correctChoice: string,
    ) {
        if (this.m_isMultipleChoiceQuestionInMemory(question, choices) != null)
            return;
        this.multipleChoiceMemory.push({
            question,
            possibleChoices: choices,
            correctChoice,
        });
    }

    private m_deleteMultipleChoiceFromMemory(
        question: string,
        choices: string[],
    ) {
        let i = -1;
        for (const memory of this.multipleChoiceMemory) {
            i++;
            if (memory.question !== question) continue;
            if (!arraysSameSet(choices, memory.possibleChoices)) continue;
            this.multipleChoiceMemory.splice(i, 1);
            return;
        }
    }

    private async m_getSimilaritiesOrRandom(
        questionContent: string | null,
        wordContent: string,
        choices: string[],
    ) {
        if (!questionContent) return choices.map(() => Math.random());
        const targetCleaned = cleanString(questionContent);
        const choicesCleaned = choices.map(cleanString);
        return await this.m_getSimilarities(targetCleaned, choicesCleaned, wordContent);
    }

    private m_boostKnownWords(probabilityList: number[], wordList: string[]) {
        return wordList.map((word, idx) => {
            const prob = probabilityList[idx];
            if (prob == null) return;
            if (this.knownWordsInList.has(cleanString(word).toLowerCase()))
                return prob * 2.5;
            return prob;
        });
    }

    private async m_recordQuestion(questionText: string, answer: string, possibleAnswers: string[]) {
        await this.emitAsync("report_question_data", {
            question_content: cleanString(questionText),
            answer: answer,
            question_type: "question",
            possible_answers: possibleAnswers
        });
    }

    private async m_tryChoices() {
        if (!this.questionWrapper) return;
        const choicesElement = this.questionWrapper.querySelector(
            ".choices",
        ) as HTMLDivElement | null;
        const questionElement = this.questionWrapper.querySelector(
            ".questionContent",
        ) as HTMLDivElement | null;
        const instructionsElement = this.questionWrapper.querySelector(
            ".instructions",
        ) as HTMLDivElement | null;
        if (!choicesElement || !questionElement || !instructionsElement)
            throw new Error("Missing elements");

        const choices = Array.from(
            choicesElement.children,
        ) as HTMLAnchorElement[];
        const questionContent =
            (questionElement.textContent ?? "") +
            (instructionsElement.textContent ?? "");
        const targetWordElement = instructionsElement.querySelector("strong");
        let targetWord = targetWordElement?.textContent;
        if (targetWord)
            this.knownWordsInList.add(cleanString(targetWord).toLowerCase());

        // Check memory
        const possibleAnswers = choices.map((c) => c.textContent ?? "");
        const memorized = this.m_isMultipleChoiceQuestionInMemory(
            questionContent,
            possibleAnswers,
        );

        if (memorized) {
            const iconPositions = await this.m_getIconPositions();
            choices.forEach(async (choice, idx) => {
                if (choice.textContent === memorized) {
                    const pos = iconPositions[idx];
                    if (pos) await this.m_click(pos);
                }
            });
            return;
        }

        // Otherwise similarity guess
        const sentenceElement = questionElement.querySelector(".sentence");
        const sentence =
            sentenceElement && sentenceElement.textContent?.includes("_")
                ? cleanString(sentenceElement.textContent)
                : (targetWord ?? "");
        let questionContentSimilarity = questionContent + "\n" + sentence;
        const similaritiesUnprocessed = await this.m_getSimilaritiesOrRandom(
            questionContentSimilarity,
            targetWord ?? "",
            possibleAnswers
            
        );
        const similarities = this.m_boostKnownWords(
            similaritiesUnprocessed,
            possibleAnswers,
        );
        const scored = possibleAnswers
            .map((answer, i) => ({ answer, score: similarities[i] ?? 0 }))
            .sort((a, b) => b.score - a.score)
            .map((x) => x.answer);

        for (const answer of scored) {
            for (const choice of choices) {
                if (choice.textContent !== answer) continue;
                const coords = getElementScreenCoordinates(choice);
                await this.m_click({ x: coords.x + 10, y: coords.y + 10 });
                await wait(1000);
                if (this.m_isCorrect()) {
                    this.m_recordQuestion(questionContentSimilarity, answer, possibleAnswers)
                    return;
                }
            }
        }
    }

    private m_isSpelling() {
        return !!this.questionWrapper?.querySelector(".spellit");
    }
    private m_isImageQuestion() {
        return !!this.questionWrapper?.querySelector(".typeI");
    }
    private m_isSummaryScreen() {
        return !!this.questionWrapper?.querySelector(".roundSummary");
    }
    private m_isAchievementScreen() {
        return !!this.questionWrapper?.querySelector(".hero");
    }

    private async m_clickNext() {
        const nextButton = document.querySelector(
            '[aria-label="Next question"]',
        ) as HTMLButtonElement | null;
        if (!nextButton) return;
        const nextButtonSpan = nextButton.querySelector(
            "span",
        ) as HTMLSpanElement | null;
        if (!nextButtonSpan) return;
        const coords = getElementScreenCoordinates(nextButtonSpan);
        await this.m_click({ x: coords.x, y: coords.y });
    }

    private m_rememberBlurb() {
        if (!this.questionWrapper || !this.m_isCorrect()) return;
        const blurb = this.questionWrapper.querySelector(".blurb");
        if (blurb) this.blurbMemory.add(blurb.textContent ?? "");
    }

    private m_hookLog() {
        chrome.runtime.onMessage.addListener(
            (
                msg: any,
                _sender: chrome.runtime.MessageSender,
                _sendResponse: (response?: any) => void,
            ): boolean | Promise<any> | undefined => {
                if (!msg || msg.type !== "socket:event" || msg.event !== "log")
                    return undefined;

                this.logContent += String(msg.data);
                if (!this.logBox) return undefined;

                this.logBox.style.lineHeight = "1em";
                this.logBox.style.height = "3em";
                this.logBox.style.overflowY = "auto";
                this.logBox.style.fontFamily = "monospace";
                this.logBox.style.whiteSpace = "pre-wrap";
                this.logBox.style.wordBreak = "break-word";
                this.logBox.style.position = "fixed";
                this.logBox.style.bottom = "0%";
                this.logBox.style.left = "0%";
                this.logBox.style.color = "white";
                this.logBox.textContent = this.logContent;
                this.logBox.scrollTop = this.logBox.scrollHeight;

                return undefined; // explicitly return undefined instead of void
            },
        );
    }

    private m_refreshLogP() {
        const newP = document.createElement("p");
        document.body.appendChild(newP);
        this.logBox = newP;
        this.logContent = "";
    }
    private async m_solveSpelling() {
        if (!this.questionWrapper) return;

        await this.m_click({ x: 100, y: 100 });
        await wait(1000);

        const completedSentenceElement =
            this.questionWrapper.querySelector(".complete");
        if (!completedSentenceElement)
            throw new Error("No completed sentence element");

        const theWord = completedSentenceElement.querySelector("strong");
        if (!theWord) throw new Error("No STRONG");

        const playButtons = (await this.emitAsync(
            "locateSpell",
            null,
        )) as IconPositionEntry[];
        const spellButtons = (await this.emitAsync(
            "locateSpellButton",
            null,
        )) as IconPositionEntry[];

        const typeCoords = playButtons[0];
        const spellCoords = spellButtons[0];

        if (!typeCoords || !spellCoords) throw new Error("Missing buttons");

        await this.m_click({ x: typeCoords.x + 50, y: typeCoords.y });
        await wait(1000);

        await this.emitAsync("type", theWord.textContent);

        await wait((theWord.textContent?.length ?? 1) * 100);

        await this.m_click({ x: spellCoords.x, y: spellCoords.y });
        await wait(1000);
    }

    private async m_solveImageQuestion() {
        if (!this.questionWrapper) return;

        const wordElement = this.questionWrapper.querySelector(
            ".word",
        ) as HTMLDivElement | null;
        if (!wordElement) return;

        const choicesElement = this.questionWrapper.querySelector(
            ".choices",
        ) as HTMLDivElement | null;
        if (!choicesElement) return;

        const word = wordElement.textContent ?? "";

        if (this.imageMemory[word] == null) {
            for (const choice of choicesElement.children) {
                const style = (choice as HTMLElement).style.backgroundImage;
                const coords = getElementScreenCoordinates(
                    choice as HTMLElement,
                );

                await this.m_click({ x: coords.x + 50, y: coords.y + 50 });
                await wait(1000);

                if (this.m_isCorrect()) {
                    this.imageMemory[word] = style;
                    return;
                }
            }
        } else {
            const correctStyle = this.imageMemory[word];

            for (const choice of choicesElement.children) {
                const style = (choice as HTMLElement).style.backgroundImage;

                if (style === correctStyle) {
                    const coords = getElementScreenCoordinates(
                        choice as HTMLElement,
                    );

                    await this.m_click({ x: coords.x + 50, y: coords.y + 50 });
                    await wait(1000);

                    if (!this.m_isCorrect()) {
                        delete this.imageMemory[word];
                    }

                    return;
                }
            }

            delete this.imageMemory[word];
        }
    }

    private async m_botLoop() {
        await this.m_refreshLogP();
        while (true) {
            await wait(500);
            await this.m_getQuestionWrapper();

            if (this.m_isSummaryScreen()) {
                await wait(2000);
                await this.m_clickNext();
                continue;
            }
            if (this.m_isSpelling()) {
                await wait(2000);
                await this.m_solveSpelling()
                await wait(2000);
                await this.m_clickNext();
                continue;
            }
            if (this.m_isImageQuestion()) {
                await wait(2000);
                await this.m_solveImageQuestion()
                await wait(2000);
                await this.m_clickNext();
                continue;
            }
            if (this.m_isAchievementScreen()) {
                await wait(2000);
                await this.m_clickNext();
                continue;
            }

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
        this.m_hookLog();
        await wait(2000);
        await this.m_getQuestionWrapper();
        this.m_refreshLogP();
        this.m_botLoop();
    }
}

function onLoad() {
    try {
        new App();
    } catch (err) {
        console.error("Failed to initialize:", err);
        alert("Failed to initialize");
    }
}

window.onload = onLoad;
