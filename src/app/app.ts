import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  afterNextRender,
  signal,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  protected readonly previewCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('previewCanvas');
  protected readonly palette = signal<string[]>([]);
  protected readonly statusMessage = signal('Paste a screenshot with Ctrl/Cmd + V.');
  protected readonly copiedColor = signal<string | null>(null);
  protected readonly hasImage = signal(false);

  private image: ImageBitmap | null = null;
  private readonly sourceCanvas = document.createElement('canvas');
  private readonly sourceContext = this.sourceCanvas.getContext('2d');
  private previewContext: CanvasRenderingContext2D | null = null;
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
      this.statusMessage.set('Clipboard has no image. Copy a screenshot first, then paste.');
      return;
    }

    event.preventDefault();
    const nextImage = await createImageBitmap(imageFile);
    this.image?.close();
    this.image = nextImage;
    this.hasImage.set(true);

    this.sourceCanvas.width = nextImage.width;
    this.sourceCanvas.height = nextImage.height;
    this.sourceContext?.clearRect(0, 0, nextImage.width, nextImage.height);
    this.sourceContext?.drawImage(nextImage, 0, 0);

    this.fitImageInView();
    this.statusMessage.set('Image pasted. Drag to pan, wheel to zoom, click to sample colors.');
    this.renderPreview();
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
  }

  protected async copyColor(hex: string): Promise<void> {
    await this.copyToClipboard(hex);
    this.copiedColor.set(hex);
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
}
