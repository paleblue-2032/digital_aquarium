import time
import os
import json
import cv2
import numpy as np
from PIL import Image
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler


WATCH_PATH = r"C:\Users\rensh\Documents\digital_aquarium\scnanned_images"
SAVE_PATH = r"C:\Users\rensh\Documents\digital_aquarium\processed_images"
FISH_LIST_PATH = os.path.join(SAVE_PATH, 'fish_list.json')


def load_fish_list():
    if os.path.exists(FISH_LIST_PATH) and os.path.getsize(FISH_LIST_PATH) > 0:
        with open(FISH_LIST_PATH, 'r') as f:
            try: return json.load(f)
            except json.JSONDecodeError: return []
    return []


def process_image_opencv(image_path):
    try:
        time.sleep(1)
        img_bgr = cv2.imread(image_path)
        if img_bgr is None: raise ValueError("Cannot open image file")

        img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        
        img_thresh = cv2.adaptiveThreshold(
            img_gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
            cv2.THRESH_BINARY_INV, 15, 4 
        )
 
        kernel = np.ones((3,3),np.uint8)
        img_thresh_cleaned = cv2.morphologyEx(img_thresh, cv2.MORPH_OPEN, kernel, iterations=1)
        img_thresh_cleaned = cv2.morphologyEx(img_thresh_cleaned, cv2.MORPH_CLOSE, kernel, iterations=2)

 
        contours, hierarchy = cv2.findContours(
            img_thresh_cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours: raise ValueError("No contours found")

 
        largest_contour = max(contours, key=cv2.contourArea)
        mask = np.zeros(img_gray.shape, dtype=np.uint8)
        cv2.drawContours(mask, [largest_contour], -1, (255), thickness=cv2.FILLED)

 
        img_bgra = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2BGRA)
        img_bgra[:, :, 3] = mask

 
        img_rgba_pil = Image.fromarray(cv2.cvtColor(img_bgra, cv2.COLOR_BGRA2RGBA))

 
        filename_without_ext = os.path.splitext(os.path.basename(image_path))[0]
        new_filename = f"{filename_without_ext}.png"
        new_image_path = os.path.join(SAVE_PATH, new_filename)
        img_rgba_pil.save(new_image_path, "PNG")

 
        fish_list = load_fish_list()
        if new_filename not in fish_list:
            fish_list.append(new_filename)
            with open(FISH_LIST_PATH, 'w') as f: json.dump(fish_list, f)

        print(f"🆗🆗🆗✅✅✅ Processed {os.path.basename(image_path)} -> {new_filename} (OpenCV)")

    except Exception as e:
        print(f"🤔🤔🤔🤔🤔🤔")


class ChangeHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory: return
        print(f"🤩🤩🤩🤩🤩🤩 Detected new file: {event.src_path}")
        process_image_opencv(event.src_path)


if __name__ == "__main__":
    print("--- Digital Aquarium - Auto Image Processor (OpenCV) ---")
    if not os.path.exists(WATCH_PATH): print(f"🆖🆖🆖❎❎❎ Watch folder not found: {WATCH_PATH}"); exit()
    if not os.path.exists(SAVE_PATH): os.makedirs(SAVE_PATH); print(f"📂📂📂📂📂📂 Created save folder: {SAVE_PATH}")
    print(f"📁📁📁📁📁📁 Watching folder: {WATCH_PATH}")
    observer = Observer()
    observer.schedule(ChangeHandler(), WATCH_PATH, recursive=False)
    observer.start()
    print("👀👀👀👀👀👀 Monitoring for scanned images... Press Ctrl+C to stop.")
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt: observer.stop()
    observer.join()