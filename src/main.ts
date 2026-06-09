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

enum QuestionType {
    MULTIPLE_CHOICE = 0,
    IMAGE = 1
}

type QuestionData = {
    questionHash: string;
    questionText: string;
    answers: string[];
    correctAnswer: string;
    targetWord: string;
    questionType: QuestionType;
    contextualSentence: string;
}
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

    private isVariantCollector: boolean = true;

    private shouldWaitLonger: boolean = false;

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

    private fetchAsync(url: string, init: RequestInit) {
        return sendToBackground({
            type: "fetch",
            url: url,
            init: init
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
        const probabilities: { [key: string]: number } = await this.emitAsync("similarity", {
            words: words,
            target: target,
            word: word
        })

        // align to original order
        const probabilities_array: number[] = [];
        for (const word of words) {
            console.log("word:", word.trim())
            console.log("prob:", probabilities[word.trim()])
            probabilities_array.push(probabilities[word.trim()]!);
        }

        console.log("probabilities:", probabilities_array);
        console.log("original: ", probabilities);

        return probabilities_array;
    }

    private async m_click(data: { x: number; y: number }) {
        await this.emitAsync("click", { x: data.x, y: data.y });
    }

    private async m_press(data: string) {
        await this.emitAsync("press", data);
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

    private async m_recordQuestion(questionText: string, answer: string, possibleAnswers: string[], targetWord: string) {
        await this.emitAsync("report_question_data", {
            question_content: cleanString(questionText),
            answer: answer,
            question_type: "question",
            possible_answers: possibleAnswers,
            target_word: targetWord
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

        const mapToIndex: Map<string, number> = new Map();
        let c = 0;
        for (const chocie of choices) {
            console.log("choice: ", choices, " c: ", c);
            mapToIndex.set(chocie.textContent, c );
            c++;
        }

        const questionContent =
            (questionElement.textContent ?? "") +
            (instructionsElement.textContent ?? "");
        const targetWordElement = instructionsElement.querySelector("strong");
        let targetWord = targetWordElement?.textContent;
        if (!targetWord) {
            const sentence = questionElement.querySelector(".sentence");1
            if (sentence) {
                const strongElement = sentence.querySelector("strong");
                if (strongElement) {
                    if (!strongElement.textContent.includes("_")) {
                        targetWord = strongElement.textContent;
                    }
                }
            }
            
        }
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

        let correctAnswer: string | null = null;


        let i = 0;
        for (const answer of scored) {

            if (correctAnswer != null) {
                break;
            }

            i++;
            for (const choice of choices) {
                if (choice.textContent !== answer) continue;
                // const coords = getElementScreenCoordinates(choice);
                // await this.m_click({ x: coords.x + 10, y: coords.y + 10 });


                const realIndex = mapToIndex.get(choice.textContent);
                if (realIndex == null) {
                    throw new Error("no real index");
                }
                console.log("real index:", realIndex, " choice: ", choice);

                await this.m_press((realIndex + 1).toString());
                await wait(1000);
                if (this.m_isCorrect()) {
                    this.m_recordQuestion(questionContentSimilarity, answer, possibleAnswers, targetWord ?? "(none)");
                    correctAnswer = answer;
                    break;
                }
            }
        }

        // upload

        try {
            if (correctAnswer == null) {
                throw new Error("Correct answer cannot be null!");
            }

            if (!targetWord) {
                throw new Error("No target word!");
            }

            const questionData: QuestionData = {
                questionText: instructionsElement.textContent,
                answers: possibleAnswers,
                correctAnswer: correctAnswer,
                targetWord: targetWord,
                questionType: QuestionType.MULTIPLE_CHOICE,
                contextualSentence: sentenceElement ? (sentenceElement.textContent ?? "") : "",
                questionHash: cleanString(questionContentSimilarity)
            }

            await this.m_postQuestionData(questionData);

            console.log("Uploaded question analytics");

        } catch (e) {
            console.error("Failed to upload question analytics: ", e);
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

    private async m_getNewVariantProbability() {
        const response = await this.fetchAsync("http://127.0.0.1:5000/api/v1/list/new_variant_probability", {});
        if (!response.ok) {
            throw new Error("Failed to fetch new variant probability: request failed");
        }

        const data = response.body;
        if (!data.data) {
            throw new Error("No field 'data' in response");
        }
        if (data.data.probability == null) {
            throw new Error("No field 'probability' in response data");
        }

        const probability: number = data.data.probability;

        console.log("New variant probability is: ", probability);

        return probability;

    }

    private async m_clickRestart() {
        const replayButton = document.querySelector(".replay") as HTMLButtonElement | null;
        if (!replayButton) {
            throw new Error("Unable to replay: button not found");
        }

        const coords = getElementScreenCoordinates(replayButton);
        console.log("Clicking replay");

        console.log("post shouldConfirm = true");
        window.postMessage({
            type: "ENABLE_CONFIRM"
        });
        await this.m_click({x: coords.x + 10, y: coords.y + 10});
        console.log("button clicked");
    }

    private async m_clickNext() {
        /* const nextButton = document.querySelector(
            '[aria-label="Next question"]',
        ) as HTMLButtonElement | null;
        if (!nextButton) return;
        const nextButtonSpan = nextButton.querySelector(
            "span",
        ) as HTMLSpanElement | null;
        if (!nextButtonSpan) return;
        const coords = getElementScreenCoordinates(nextButtonSpan);
        await this.m_click({ x: coords.x, y: coords.y }); */
        await this.m_press("right");
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

    private async m_postQuestionData(questionData: QuestionData) {
        if (!questionData.answers.includes(questionData.correctAnswer)) {
            throw new Error("Correct answer is not in answers");
        }

        console.log("Hash string text is: ", questionData.questionHash);

        const answerIndex = questionData.answers.indexOf(questionData.correctAnswer);

        const response = await this.fetchAsync("http://127.0.0.1:5000/api/v1/question/report", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                question_text: questionData.questionText,
                contextual_sentence: questionData.contextualSentence,
                target_word: questionData.targetWord,
                question_type: questionData.questionType,
                answers: questionData.answers,
                correct_answer_index: answerIndex,
                question_hash: questionData.questionHash
            })
        });

        if (!response.ok) {
            throw new Error("Failed to report question data: request failed: " + response.status + " " + response.statusText);
        }
    }

    private async m_solveSpelling() {
        if (!this.questionWrapper) return;

        // await this.m_click({ x: 100, y: 100 });

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
        await wait(150);

        await this.emitAsync("type", theWord.textContent);

        await wait((theWord.textContent?.length ?? 1) * 100);

        await this.m_click({ x: spellCoords.x, y: spellCoords.y });
        // await wait(1000);
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
                await wait(250);

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
                    await wait(250);

                    if (!this.m_isCorrect()) {
                        delete this.imageMemory[word];
                    }

                    return;
                }
            }

            delete this.imageMemory[word];
        }
    }

    private m_isEndingScreen() {
        return !!this.questionWrapper?.querySelector(".practiceComplete");
    }

    private async m_botLoop() {
        await this.m_refreshLogP();
        while (true) {
            await wait(750);
            if (this.shouldWaitLonger) {
                await wait(3000);
                this.shouldWaitLonger = false;
            }
            await this.m_getQuestionWrapper();

            if (this.m_isSummaryScreen()) {
                await wait(2000);
                await this.m_clickNext();
                this.shouldWaitLonger = true;
                continue;
            }
            if (this.m_isSpelling()) {
                await this.m_solveSpelling()
                await wait(2000);
                await this.m_clickNext();
                this.shouldWaitLonger = true;
                continue;
            }
            if (this.m_isImageQuestion()) {
                await this.m_solveImageQuestion()
                await wait(2000);
                await this.m_clickNext();
                this.shouldWaitLonger = true;
                continue;
            }
            if (this.m_isAchievementScreen()) {
                await wait(2000);
                await this.m_clickNext();
                this.shouldWaitLonger = true;
                continue;
            }
            if (this.m_isEndingScreen()) {
                if (this.isVariantCollector) {
                    await wait(2000);
                    await this.m_clickRestart();
                    continue;
                } else {
                    break;
                }

            }

            await this.m_tryChoices();
            await wait(250);
            if (this.m_isCorrect()) {
                this.m_rememberBlurb();
                await this.m_clickNext();
            }

            if (this.isVariantCollector) {
                console.log("Collector, fetching new variant probability");
                const newVariantProbability = await this.m_getNewVariantProbability();
                if (newVariantProbability < 0.03) {
                    console.log("Reached 97% chance probabilities collected, ending");
                    return;
                }
            }
        }
    }

    private async m_switchList() {

        const url = window.location.href;

        // Regex explanation:
        // - \/lists\/ : matches the literal "/lists/" part
        // - (\d+)     : captures one or more digits (this is the ID)
        const match = url.match(/\/lists\/(\d+)/);
        // match[1] contains the captured digits if the regex succeeded
        const listId = match ? match[1] : null;
        if (!listId) {
            throw new Error("Unable to find list ID in URL!");
        }

        // call switch list

        const listIdInt = parseInt(listId)
        if (!listIdInt || Number.isNaN(listIdInt)) {
            throw new Error("Failed to parse list ID, not a valid integer");
        }

        const response = await this.fetchAsync("http://127.0.0.1:5000/api/v1/list/switch", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                list_id: listIdInt
            })
        });

        if (!response.ok) {
            throw new Error("Failed to switch list to current: request failed: " + response.status + " " + response.statusText);
        } else {
            console.log("Switched list ID to: ", listIdInt);
        }
    }

    private postConfirmFalse() {
        console.log("post shouldConfirm = false");
        window.postMessage({
            type: "DISABLE_CONFIRM"
        });
    }


    private async m_initialize() {
        this.m_switchList();
        this.m_hookLog();
        await wait(2000);
        await this.m_getQuestionWrapper();
        this.m_refreshLogP();
        this.postConfirmFalse();
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
