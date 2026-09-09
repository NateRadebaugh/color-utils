import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  afterNextRender,
  signal,
  viewChild,
} from '@angular/core';

type ToastLevel = 'info' | 'success' | 'error';

interface ToastMessage {
  id: number;
  text: string;
  level: ToastLevel;
}

interface ScreenshotHistoryItem {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  palette: string[];
}

@Component({
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  protected readonly previewCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('previewCanvas');
  protected readonly palette = signal<string[]>([]);
  protected readonly hasImage = signal(false);
  protected readonly toasts = signal<ToastMessage[]>([]);
  protected readonly screenshotHistory = signal<ScreenshotHistoryItem[]>([]);
  protected readonly activeScreenshotId = signal<string | null>(null);
  protected readonly galleryExpanded = signal(false);

  private image: ImageBitmap | null = null;
  private readonly sourceCanvas = document.createElement('canvas');
  private readonly sourceContext = this.sourceCanvas.getContext('2d');
  private previewContext: CanvasRenderingContext2D | null = null;
  private toastIdCounter = 0;
  private historyIdCounter = 0;
  private readonly toastTimers = new Map<number, number>();
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragged = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  constructor() {
    afterNextRender(() => {
      const canvas = this.previewCanvas().nativeElement;
      this.previewContext = canvas.getContext('2d');
      this.resizeCanvas();
      this.renderPreview();
    });
  }

  ngOnDestroy(): void {
    this.image?.close();
    for (const timeoutId of this.toastTimers.values()) {
      window.clearTimeout(timeoutId);
    }
    this.toastTimers.clear();
  }

  @HostListener('window:resize')
  protected onResize(): void {
    this.resizeCanvas();
    this.renderPreview();
  }

  @HostListener('window:paste', ['$event'])
  protected async onPaste(event: ClipboardEvent): Promise<void> {
    const imageItem = event.clipboardData?.items
      ? Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))
      : undefined;
    const imageFile = imageItem?.getAsFile();

    if (!imageFile) {
      this.showToast('Clipboard has no image. Copy a screenshot first, then paste.', 'error');
      return;
    }

    event.preventDefault();
    try {
      const [nextImage, dataUrl] = await Promise.all([createImageBitmap(imageFile), this.blobToDataUrl(imageFile)]);
      const historyItem: ScreenshotHistoryItem = {
        id: this.nextHistoryId(),
        dataUrl,
        width: nextImage.width,
        height: nextImage.height,
        palette: [],
      };
      this.screenshotHistory.update((history) => [historyItem, ...history]);
      await this.activateHistoryItem(historyItem, nextImage);
      this.showToast('Image pasted. Drag to pan, wheel to zoom, click to sample colors.', 'success');
    } catch {
      this.showToast('Unable to read the pasted image.', 'error');
    }
  }

  protected onCanvasPointerDown(event: PointerEvent): void {
    if (!this.hasImage()) {
      return;
    }

    const canvas = this.previewCanvas().nativeElement;
    canvas.setPointerCapture(event.pointerId);
    this.dragging = true;
    this.dragged = false;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  }

  protected onCanvasPointerMove(event: PointerEvent): void {
    if (!this.dragging || !this.hasImage()) {
      return;
    }

    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      this.dragged = true;
    }
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.panX += dx;
    this.panY += dy;
    this.renderPreview();
  }

  protected onCanvasPointerUp(event: PointerEvent): void {
    if (!this.dragging || !this.hasImage()) {
      return;
    }

    const canvas = this.previewCanvas().nativeElement;
    canvas.releasePointerCapture(event.pointerId);
    this.dragging = false;

    if (!this.dragged) {
      this.sampleColorAtClientPoint(event.clientX, event.clientY);
    }
  }

  protected onCanvasWheel(event: WheelEvent): void {
    if (!this.hasImage()) {
      return;
    }

    event.preventDefault();
    const canvas = this.previewCanvas().nativeElement;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const imageX = (mouseX - this.panX) / this.zoom;
    const imageY = (mouseY - this.panY) / this.zoom;
    const scaleFactor = Math.exp(-event.deltaY * 0.001);
    const nextZoom = Math.min(12, Math.max(0.1, this.zoom * scaleFactor));

    this.zoom = nextZoom;
    this.panX = mouseX - imageX * this.zoom;
    this.panY = mouseY - imageY * this.zoom;
    this.renderPreview();
  }

  protected addColorToPalette(hex: string): void {
    this.palette.update((colors) => [...colors, hex]);
    const activeId = this.activeScreenshotId();
    if (!activeId) {
      return;
    }
    this.screenshotHistory.update((history) =>
      history.map((item) =>
        item.id === activeId ? { ...item, palette: [...item.palette, hex] } : item,
      ),
    );
  }

  protected async copyColor(hex: string): Promise<void> {
    try {
      await this.copyToClipboard(hex);
      this.showToast(`Copied ${hex} to clipboard.`, 'success');
    } catch {
      this.showToast(`Failed to copy ${hex}.`, 'error');
    }
  }

  protected async openHistoryItem(item: ScreenshotHistoryItem): Promise<void> {
    await this.activateHistoryItem(item);
  }

  protected async removeHistoryItem(itemId: string): Promise<void> {
    const currentHistory = this.screenshotHistory();
    const nextHistory = currentHistory.filter((item) => item.id !== itemId);
    const wasActive = this.activeScreenshotId() === itemId;
    this.screenshotHistory.set(nextHistory);

    if (!wasActive) {
      return;
    }

    if (nextHistory.length === 0) {
      this.clearCurrentImage();
      this.showToast('Removed screenshot from history.', 'info');
      return;
    }

    await this.activateHistoryItem(nextHistory[0]);
    this.showToast('Removed screenshot from history.', 'info');
  }

  protected toggleGallerySize(): void {
    this.galleryExpanded.update((expanded) => !expanded);
  }

  protected resetWorkspace(): void {
    this.clearCurrentImage();
    this.showToast('Reset current image and palette.', 'info');
  }

  private sampleColorAtClientPoint(clientX: number, clientY: number): void {
    const canvas = this.previewCanvas().nativeElement;
    const rect = canvas.getBoundingClientRect();
    const imageX = Math.floor((clientX - rect.left - this.panX) / this.zoom);
    const imageY = Math.floor((clientY - rect.top - this.panY) / this.zoom);
    if (!this.image || !this.sourceContext) {
      return;
    }
    if (imageX < 0 || imageY < 0 || imageX >= this.image.width || imageY >= this.image.height) {
      return;
    }

    const pixel = this.sourceContext.getImageData(imageX, imageY, 1, 1).data;
    const hex = `#${[pixel[0], pixel[1], pixel[2]]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`;
    this.addColorToPalette(hex);
    void this.copyColor(hex);
  }

  private fitImageInView(): void {
    if (!this.image) {
      return;
    }

    const canvas = this.previewCanvas().nativeElement;
    const fitScale = Math.min(canvas.width / this.image.width, canvas.height / this.image.height);
    this.zoom = Math.max(0.1, fitScale * 0.95);
    this.panX = (canvas.width - this.image.width * this.zoom) / 2;
    this.panY = (canvas.height - this.image.height * this.zoom) / 2;
  }

  private resizeCanvas(): void {
    const canvas = this.previewCanvas().nativeElement;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
  }

  private renderPreview(): void {
    const canvas = this.previewCanvas().nativeElement;
    const ctx = this.previewContext;
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#101828';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!this.image) {
      return;
    }

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    ctx.drawImage(this.image, 0, 0);
    ctx.restore();
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.append(textArea);
    textArea.select();
    document.execCommand('copy');
    textArea.remove();
  }

  private nextHistoryId(): string {
    this.historyIdCounter += 1;
    return `shot-${this.historyIdCounter}`;
  }

  private async activateHistoryItem(item: ScreenshotHistoryItem, image?: ImageBitmap): Promise<void> {
    try {
      const nextImage = image ?? (await this.imageBitmapFromDataUrl(item.dataUrl));
      this.setCurrentImage(nextImage);
      this.palette.set([...item.palette]);
      this.activeScreenshotId.set(item.id);
      this.renderPreview();
    } catch {
      this.showToast('Unable to load this screenshot from history.', 'error');
    }
  }

  private setCurrentImage(nextImage: ImageBitmap): void {
    this.image?.close();
    this.image = nextImage;
    this.hasImage.set(true);
    this.sourceCanvas.width = nextImage.width;
    this.sourceCanvas.height = nextImage.height;
    this.sourceContext?.clearRect(0, 0, nextImage.width, nextImage.height);
    this.sourceContext?.drawImage(nextImage, 0, 0);
    this.fitImageInView();
  }

  private clearCurrentImage(): void {
    this.image?.close();
    this.image = null;
    this.hasImage.set(false);
    this.palette.set([]);
    this.activeScreenshotId.set(null);
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.renderPreview();
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  private async imageBitmapFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
    const response = await fetch(dataUrl);
    if (!response.ok) {
      throw new Error('Unable to load image data.');
    }
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  private showToast(text: string, level: ToastLevel): void {
    this.toastIdCounter += 1;
    const toastId = this.toastIdCounter;
    this.toasts.update((toasts) => [...toasts, { id: toastId, text, level }]);
    const timeoutId = window.setTimeout(() => {
      this.dismissToast(toastId);
    }, 2800);
    this.toastTimers.set(toastId, timeoutId);
  }

  private dismissToast(toastId: number): void {
    const timeoutId = this.toastTimers.get(toastId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      this.toastTimers.delete(toastId);
    }
    this.toasts.update((toasts) => toasts.filter((toast) => toast.id !== toastId));
  }
}
