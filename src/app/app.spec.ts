import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render color picker heading', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Screenshot color picker');
  });

  it('should append colors to the palette', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;

    app['addColorToPalette']('#112233');
    app['addColorToPalette']('#AABBCC');

    expect(app['palette']()).toEqual(['#112233', '#AABBCC']);
  });

  it('should reset current palette and active screenshot state', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;

    app['palette'].set(['#112233']);
    app['activeScreenshotId'].set('shot-1');
    app['hasImage'].set(true);
    app['resetWorkspace']();

    expect(app['palette']()).toEqual([]);
    expect(app['activeScreenshotId']()).toBeNull();
    expect(app['hasImage']()).toBe(false);
  });

  it('should toggle gallery size state', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;

    expect(app['galleryExpanded']()).toBe(false);
    app['toggleGallerySize']();
    expect(app['galleryExpanded']()).toBe(true);
  });
});
