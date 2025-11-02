// === グローバル変数と設定 ===
let allFish = [];
let displayedFileNames = new Set(); // スキャンされた魚のファイル名を記録
let lastCheckTime = 0;
let bubbles = [];
let ripples = [];
let foodPellets = [];

let stick = { x: 0, y: 0, isPressed: false };
let targetCursor = { x: 0, y: 0, isVisible: false };
let displayCursor = { x: 0, y: 0 };

const VIRTUAL_DAY_DURATION = 10 * 60 * 1000; // 10分で1日
const FISH_LIFESPAN = 180; // スキャンされた魚の寿命（秒）

let port; // シリアルポート
let reader;
let serialBuffer = '';

// ★★★ デフォルト魚用の設定 ★★★
let defaultFishImages = [];
const NUM_DEFAULT_FISH = 3; // 常に泳がせるデフォルト魚の数
const DEFAULT_FISH_FOLDER = 'default_fish/'; // デフォルト魚画像フォルダ名
// ↓↓↓ 用意した画像ファイル名に合わせて書き換えてください ↓↓↓
const DEFAULT_FISH_FILES = ['fish1.png', 'fish2.png', 'fish3.png'];

let defaultFishInitialized = false;

let bubbleSound;


function preload() {
    // ★★★ デフォルト魚の画像を読み込む ★★★
    for (let fileName of DEFAULT_FISH_FILES) {
        try {
            let img = loadImage(DEFAULT_FISH_FOLDER + fileName);
            defaultFishImages.push(img);
            console.log(`デフォルト魚画像読み込み: ${fileName}`);
        } catch (e) {
            console.error(`デフォルト魚画像の読み込み失敗: ${fileName}`, e);
        }
    }
    
    try {
        soundFormats('mp3', 'wav');
        bubbleSound = loadSound('bubble_pop.mp3'); // Make sure you have bubble_pop.mp3 in p5_aquarium folder
        console.log("泡の効果音を読み込みました。");
    } catch (e) {
        console.error("効果音ファイルの読み込みに失敗しました:", e);
        bubbleSound = null;
    }
}

// === p5.js 初期設定 ===
function setup() {
    createCanvas(windowWidth, windowHeight);
    displayCursor.x = width / 2; // 表示カーソルの初期位置
    displayCursor.y = height / 2;

    let connectButton = select('#connectButton'); // HTMLのボタンを取得
    connectButton.mousePressed(connectSerial); // ボタンが押されたらconnectSerial関数を実行

    // ★★★ デフォルト魚を生成 (ランダムではなく順番に) ★★★
    if (!defaultFishInitialized && defaultFishImages.length > 0) {
        let count = min(NUM_DEFAULT_FISH, defaultFishImages.length);
        for (let i = 0; i < count; i++) {
            let img = defaultFishImages[i];
             if (img.width > 0 && img.height > 0) {
                allFish.push(new Fish(img, true)); // isDefault=trueで生成
            } else {
                 console.warn(`デフォルト魚画像 ${DEFAULT_FISH_FILES[i]} が有効ではありません。スキップします。`);
            }
        }
        console.log(`${allFish.filter(f => f.isDefault).length}匹のデフォルト魚を生成しました。`);
        defaultFishInitialized = true;
    } else if (!defaultFishInitialized) {
        console.warn("デフォルト魚の画像が見つかりませんでした。");
        defaultFishInitialized = true;
    }

    checkNewFish(); // スキャン魚の初期チェック
}

// === シリアルポートに接続する関数 ===
async function connectSerial() {
    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 9600 });
        console.log("シリアルポートに接続しました！");
        select('#connectButton').hide();

        if (getAudioContext().state !== 'running') {
            await getAudioContext().resume();
            console.log("AudioContext resumed by user interaction.");
        }
        readSerialData(); 
    } catch (err) { console.error("シリアルポート接続エラー:", err); alert("シリアルポートへの接続に失敗しました。\n" + err); }
}


// === シリアルデータを非同期で読み続ける関数 ===
async function readSerialData() {
    while (port && port.readable) {
        reader = port.readable.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const text = new TextDecoder().decode(value);
                serialBuffer += text;
                let newlineIndex;
                while ((newlineIndex = serialBuffer.indexOf('\n')) >= 0) {
                    const line = serialBuffer.substring(0, newlineIndex).trim();
                    serialBuffer = serialBuffer.substring(newlineIndex + 1);
                    if (line) parseSerialData(line);
                }
            }
        } catch (error) { console.error('シリアル読み取りエラー:', error); }
        finally { if (reader) { reader.releaseLock(); } }
    }
    console.log("シリアルポートが閉じられました。");
}

// === 受信データを解釈して処理する関数 ===
function parseSerialData(line) {
    // ★★★ 音のスリープ解除 ★★★
    if (getAudioContext().state !== 'running') {
        getAudioContext().resume();
    }

    const data = line.split(',');
     if (data.length < 4) return;
    const dataType = data[0];
    if (dataType === "STICK") {
        let newX_raw = parseInt(data[1]);
        let newY_raw = parseInt(data[2]);
        let newTouchState = (parseInt(data[3]) === 0);
        if (newTouchState) {
            targetCursor.isVisible = true;
            targetCursor.x = map(newX_raw, -30, 30, 0, width, true);
            targetCursor.y = map(newY_raw, -30, 30, 0, height, true);
        } else if (!newTouchState && stick.isPressed) {
            targetCursor.isVisible = false;
            feedFish(targetCursor.x, targetCursor.y);
        }
        stick.isPressed = newTouchState;
    }
}


// === p5.js メインループ ===
function draw() {
    drawAquariumBackground();

    // 泡
    if (frameCount % 15 === 0) bubbles.push(new Bubble());
    for (let i = bubbles.length - 1; i >= 0; i--) {
        bubbles[i].update(); bubbles[i].display();
        if (bubbles[i].isFinished()) bubbles.splice(i, 1);
    }

    // 照準カーソル
    displayCursor.x += (targetCursor.x - displayCursor.x) * 0.3;
    displayCursor.y += (targetCursor.y - displayCursor.y) * 0.3;
    if (targetCursor.isVisible) {
        let breath = sin(frameCount * 0.1) * 5 + 30;
        fill(255, 255, 255, 80); noStroke();
        ellipse(displayCursor.x, displayCursor.y, breath, breath);
        fill(255, 255, 255, 180);
        ellipse(displayCursor.x, displayCursor.y, 8, 8);
    }

    // エサ粒
    for (let i = foodPellets.length - 1; i >= 0; i--) {
        foodPellets[i].update(); foodPellets[i].display();
        if (foodPellets[i].isFinished()) foodPellets.splice(i, 1);
    }

    // 波紋
    for (let i = ripples.length - 1; i >= 0; i--) {
        ripples[i].update(); ripples[i].display();
        if (ripples[i].isFinished()) ripples.splice(i, 1);
    }

    // 魚
    for (let i = allFish.length - 1; i >= 0; i--) {
        let fish = allFish[i];
        fish.applyBehaviors(allFish);
        fish.update();
        fish.checkCollisionWithBubbles(bubbles);
        fish.display();
        fish.checkBounds();
        if (!fish.isDefault && fish.isDead()) {
             allFish.splice(i, 1);
        }
    }

    if (millis() - lastCheckTime > 3000) checkNewFish();
}

// === 背景描画 ===
function drawAquariumBackground() {
    let elapsedTime = millis() % VIRTUAL_DAY_DURATION;
    let virtualHour = map(elapsedTime, 0, VIRTUAL_DAY_DURATION, 0, 24);
    let fromColor, toColor, ratio;
    if (virtualHour >= 5 && virtualHour < 18) {
        fromColor = color('#b3e5fc'); toColor = color('#03a9f4');
        ratio = map(virtualHour, 5, 18, 0, 1);
    } else {
        fromColor = color('#03a9f4'); toColor = color('#01579b');
        if (virtualHour >= 18) ratio = map(virtualHour, 18, 29, 0, 1);
        else ratio = map(virtualHour, -5, 5, 0, 1);
    }
    noStroke();
    for (let i = 0; i <= height; i++) {
        let inter = map(i, 0, height, 0, 1);
        let c = lerpColor(fromColor, toColor, inter);
        fill(c); rect(0, i, width, 1);
    }
}

// === エサやり関数 ===
function feedFish(x, y) {
    let numPellets = 10;
    for (let i = 0; i < numPellets; i++) {
        foodPellets.push(new FoodPellet(x, y));
    }
    ripples.push(new Ripple(x, y));
}

// === マウスクリック無効化 ===
function mousePressed() {
    if (getAudioContext().state !== 'running') {
        getAudioContext().resume().then(() => { console.log("AudioContext resumed."); });
    }
    let connectButton = select('#connectButton');
    if (connectButton && connectButton.style('display') !== 'none') {}
    else { console.log("エサやりはスティックで操作してください。"); }
}

// === 新しい魚チェック ===
function checkNewFish() {
    try {
        loadJSON('../processed_images/fish_list.json?t=' + new Date().getTime(), (fishList) => {
            if (!fishList || !Array.isArray(fishList)) return;
            fishList.forEach(fileName => {
                if (typeof fileName === 'string' && !displayedFileNames.has(fileName)) {
                    displayedFileNames.add(fileName);
                    console.log(`🐡 新しい魚ファイルを発見、読み込み開始: ${fileName}`);
                    let path = `../processed_images/${fileName}`;
                    loadImage(path, img => {
                        if (img.width > 0 && img.height > 0) {
                            allFish.push(new Fish(img, false)); // isDefault=false
                            console.log(`✅ 画像読み込み成功、魚を追加: ${fileName}`);
                        } else { console.error(`読み込んだ画像が無効です: ${path}`); }
                    }, err => { console.error(`画像の読み込み失敗: ${path}`, err); });
                }
            });
        });
    } catch (e) { console.error("checkNewFish中に予期せぬエラー:", e); }
}


// ==============================
// === 魚クラス (Fish Class) ===
// ==============================
class Fish {
    constructor(img, isDefaultFish = false) {
        this.img = img;
        this.isDefault = isDefaultFish;
        this.size = this.isDefault ? random(150, 300) : random(250, 450);
        this.birthTime = millis();
        let speed = random(1, this.isDefault ? 2.5 : 3);
        let startY = random(height * 0.2, height * 0.8);
        if (random() < 0.5) { this.pos = createVector(width+this.size/2, startY); this.vel = createVector(-speed, 0); }
        else { this.pos = createVector(-this.size/2, startY); this.vel = createVector(speed, 0); }
        this.pukapukaAngle = random(TWO_PI); this.pukapukaSpeed = random(0.02, 0.05); this.pukapukaAmplitude = random(10, 30);
        this.targetY = startY; this.baseY = startY;
        this.acc = createVector(); this.maxSpeed = this.isDefault ? 3.5 : 4;
        this.maxForce = 0.05;
        this.awareness = random(0.5, 1.0); this.targetFood = null;
        this.isEating = false; this.eatTimer = 0;
        this.wanderTimer = millis() + random(2000, 5000);
        this.bobbingAngle = random(TWO_PI);
        this.bobbingSpeed = random(0.1, 0.2);
        this.bobbingAmount = this.size * 0.01; // ポンピング幅
    }

    update() {
        this.vel.add(this.acc);
        this.vel.limit(this.isEating ? this.maxSpeed * 1.5 : this.maxSpeed);
        this.pos.add(this.vel);
        this.acc.mult(0);
        // ついばみ
        if (this.isEating) { this.eatTimer--; if (this.eatTimer <= 0) { this.isEating = false; if (this.targetFood) this.eatFood(this.targetFood); } }
        // 泡当たり判定
        if (!this.targetFood && !this.isEating) { this.baseY += (this.targetY - this.baseY) * 0.1; this.pukapukaAngle += this.pukapukaSpeed; this.pos.y = this.baseY + sin(this.pukapukaAngle) * this.pukapukaAmplitude; }
        else { this.baseY = this.pos.y; this.targetY = this.pos.y; }
        // 横速度維持
        if (!this.targetFood && !this.isEating) { if (this.vel.x > 0) this.vel.x = max(this.vel.x, 1.0); if (this.vel.x < 0) this.vel.x = min(this.vel.x, -1.0); }
        // 上下ボビング角度更新
        this.bobbingAngle += this.bobbingSpeed;
        // Y座標制限
        let fishHeight = (this.img.height / this.img.width) * this.size;
        this.pos.y = constrain(this.pos.y, fishHeight / 2, height - fishHeight / 2);
    }

    applyBehaviors(fishes) {
        let separateForce = this.separate(fishes); separateForce.mult(0.5); this.applyForce(separateForce);
        let didSeek = false; if (!this.isEating) { didSeek = this.seekFoodBehavior(); }
        if (!didSeek) { this.wanderBehavior(); }
    }

    seekFoodBehavior() {
        if (this.targetFood) {
            if (this.targetFood.isFinished() || !foodPellets.includes(this.targetFood)) { this.targetFood = null; return false; }
            else { let seekForce = this.seek(this.targetFood.pos); seekForce.mult(1.5); this.applyForce(seekForce); let d = p5.Vector.dist(this.pos, this.targetFood.pos); if (d < 30 && !this.isEating) { this.startEating(); } return true; }
        }
        if (foodPellets.length > 0) {
            let closestFood = null; let closestDist = Infinity;
            for (let pellet of foodPellets) { if (pellet.isFinished()) continue; let d = p5.Vector.dist(this.pos, pellet.pos); if (d < closestDist) { closestDist = d; closestFood = pellet; } }
            if (closestFood && random() < this.awareness * 0.1) { this.targetFood = closestFood; return true; }
        }
        return false;
    }

    startEating() { this.isEating = true; this.eatTimer = 10; let force = p5.Vector.sub(this.targetFood.pos, this.pos); force.setMag(this.maxForce * 5); this.applyForce(force); }
    eatFood(food) { food.lifespan = 0; this.targetFood = null; this.isEating = false; }
    checkCollisionWithBubbles(bubbles) {
        if (this.targetFood || this.isEating) return;
        for (let i = bubbles.length - 1; i >= 0; i--) { let bubble = bubbles[i]; let d = dist(this.pos.x, this.pos.y, bubble.x, bubble.y); if (d < this.size / 2.5 + bubble.r / 2) { this.floatUp(); bubbles.splice(i, 1); } }
    }
    floatUp() { this.targetY -= 30; }
    checkBounds() {
        let didWarp = false;
        if (this.vel.x < 0 && this.pos.x < -this.size * 1.5) { this.pos.x = width + this.size * 1.5; didWarp = true; }
        if (this.vel.x > 0 && this.pos.x > width + this.size * 1.5) { this.pos.x = -this.size * 1.5; didWarp = true; }
        if (didWarp) { this.baseY = random(height * 0.2, height * 0.8); this.targetY = this.baseY; this.pos.y = this.baseY; this.targetFood = null; this.isEating = false; }
    }
    isDead() { return (millis() - this.birthTime) / 1000 > FISH_LIFESPAN; }
    display() {
        push();
        translate(this.pos.x, this.pos.y);
        let bobOffset = sin(this.bobbingAngle) * this.bobbingAmount;
        translate(0, bobOffset);
        if (this.vel.x > 0) { scale(-1, 1); } // 右向きなら反転
        imageMode(CENTER);
        image(this.img, 0, 0, this.size, this.size * (this.img.height / this.img.width));
        pop();
    }
    applyForce(force) { this.acc.add(force); }
    seek(targetPos) { let desired = p5.Vector.sub(targetPos, this.pos); let d = desired.mag(); let speed = this.maxSpeed; if (d < 50) speed = map(d, 0, 50, this.maxSpeed * 0.1, this.maxSpeed); desired.setMag(speed); let steer = p5.Vector.sub(desired, this.vel); steer.limit(this.maxForce); return steer; }
    separate(fishes) { let desiredSeparation = this.size * 0.7; let steer = createVector(); let count = 0; for (let other of fishes) { let d = dist(this.pos.x, this.pos.y, other.pos.x, other.pos.y); if ((d > 0) && (d < desiredSeparation)) { let diff = p5.Vector.sub(this.pos, other.pos); diff.normalize(); diff.div(d); steer.add(diff); count++; } } if (count > 0) { steer.div(count); } if ( steer.mag() > 0) { steer.setMag(this.maxSpeed); steer.sub(this.vel); steer.limit(this.maxForce); } return steer; }
    wanderBehavior() { if(!this.targetFood && !this.isEating && millis()>this.wanderTimer){ let w=p5.Vector.random2D();w.setMag(.1);this.applyForce(w);this.wanderTimer=millis()+random(3e3,7e3);} }
}

// ==============================
// === 泡クラス (Bubble Class) ===
// ==============================
class Bubble {
    constructor(){
        this.x=random(width); this.y=height+random(10,100);
        this.r=random(10,50); this.speed=random(1,3);
        
        // ★★★ 30%の確率で音を鳴らす ★★★
        if (bubbleSound && bubbleSound.isLoaded() && random() < 0.3) {
            // ★★★ 再生前にAudioContextの起動を試みる ★★★
            if (getAudioContext().state !== 'running') {
                getAudioContext().resume();
            }
            
            // 起動していれば再生
            if (getAudioContext().state === 'running') {
                let vol = random(0.05, 0.2); let pan = map(this.x, 0, width, -0.8, 0.8);
                bubbleSound.setVolume(vol); bubbleSound.pan(pan);
                bubbleSound.play();
            }
        }
    }
    update(){this.y-=this.speed;this.x+=random(-1,1);}
    display(){stroke(255,180);strokeWeight(2);noFill();ellipse(this.x,this.y,this.r,this.r);}
    isFinished(){return this.y<-this.r;}
}

// ==============================
// === 波紋クラス (Ripple Class) ===
// ==============================
class Ripple { constructor(x,y){this.x=x;this.y=y;this.radius=0;this.maxRadius=60;this.alpha=200;} update(){this.radius+=2;this.alpha-=5;} display(){noFill();stroke(255,255,255,this.alpha);strokeWeight(2);ellipse(this.x,this.y,this.radius*2);} isFinished(){return this.alpha<=0;} }

// ==============================
// === エサ粒クラス (FoodPellet Class) ===
// ==============================
class FoodPellet { constructor(x,y){this.pos=createVector(x+random(-30,30),y+random(-30,30));this.vel=createVector(random(-.5,.5),random(.5,1.5));this.lifespan=255*1.5;this.size=random(5,10);} update(){this.pos.add(this.vel);this.lifespan-=0.8;this.pos.x+=sin(this.lifespan*.1)*.5;} display(){fill(255,180,0,this.lifespan);noStroke();ellipse(this.pos.x,this.pos.y,this.size,this.size);} isFinished(){return this.lifespan<0;} }