import { BrowserView, app, ContextMenuParams, ipcMain } from "electron";
import { resolve } from "path";
import { appWindow } from ".";
import { NAVIGATION_HEIGHT } from "../ui/constants/window";
import { getGeneralMenu } from "./menus/general";
import { downloadFaviconFromUrl } from "./tools/favicon";
import { BLUE_1, GRAY_4 } from "@dothq/colors";
import { NEWTAB_URL, WEBUI_PREFIX, WEBUI_SUFFIX } from "../ui/constants/web";
import { parse } from "url";

export class View {
    public view: BrowserView;
    public id: string;
    public favicon: string;
    public faviconURL: string;
    public previousURL: string = '';

    private historyId: string;
    
    public errorData: any;

    constructor(id: string, url: any) {
        this.id = id;

        this.view = new BrowserView({
            webPreferences: {
                sandbox: true,
                preload: resolve(app.getAppPath(), "build", "preload.bundle.js"),
                nodeIntegration: false,
                additionalArguments: [`--tab-id=${id}`],
                contextIsolation: true,
                partition: 'persist:view',
                scrollBounce: true
            }
        })

        this.view.setBackgroundColor("#fff");

        this.view.webContents.userAgent = this.view.webContents.userAgent
            .replace(/ DotBrowser\\?.([^\s]+)/g, '')
            .replace(/ Electron\\?.([^\s]+)/g, '')
            + " Edg/83.0.478.37"

        this.view.webContents.on('did-start-loading', (_e) => {
            appWindow.window.webContents.send('view-created', { id, url })
        })

        let { width, height } = appWindow.window.getBounds()
        this.view.setBounds({ x: 0, y: appWindow.navigationHeight, width, height: height - appWindow.navigationHeight });

        this.view.setAutoResize({ width: true, height: true });
        this.view.webContents.loadURL(url);

        this.view.webContents.on('context-menu', (_event, params: ContextMenuParams) => {
            const { x, y } = params;

            const id = this.id;

            const generalMenu = getGeneralMenu(id)

            generalMenu.popup({ x, y: y + appWindow.navigationHeight })
        })

        this.view.webContents.addListener('did-navigate', this.events.viewNavigate)
        this.view.webContents.addListener('did-navigate-in-page', this.events.viewNavigateInPage)

        this.view.webContents.addListener('did-start-navigation', this.events.viewStartedNavigation)
        this.view.webContents.addListener('did-start-loading', this.events.viewStartedLoading)
        this.view.webContents.addListener('did-stop-loading', this.events.viewStoppedLoading)
        this.view.webContents.addListener('did-finish-load', this.events.viewFinishedLoading)

        this.view.webContents.addListener('new-window', this.events.viewWindowOpened)

        this.view.webContents.addListener('did-fail-load', this.events.viewFailedLoading)

        this.view.webContents.addListener('page-title-updated', this.events.viewTitleUpdated)
        this.view.webContents.addListener('page-favicon-updated', this.events.viewFaviconUpdated)
    }

    public rearrange() {
        let { width, height } = appWindow.window.getBounds()

        if(appWindow.window.isMaximized()) {
            width = width - 15
            height = height - 15
        }

        setTimeout(() => {
            this.view.setBounds({ x: 0, y: appWindow.navigationHeight, width, height: height - appWindow.navigationHeight });
        }, 0)

        this.updateZoomFactor()
    }

    private get events() {
        return {
            viewNavigate: (_event: Electron.Event, url: string, httpResponseCode: number, httpStatusText: string) => {
                appWindow.window.webContents.send(`view-url-updated-${this.id}`, url)
                appWindow.window.webContents.send(`view-blockedAds-updated-${this.id}`, 0)
                this.updateZoomFactor()
            },
            viewNavigateInPage: (_event: Electron.Event, url: string, isMainFrame: boolean) => {
                if(isMainFrame) {
                    appWindow.window.webContents.send(`view-url-updated-${this.id}`, url)
                }
            },
            viewStartedNavigation: (_event: Electron.Event, url: string, isInPlace: boolean, isMainFrame: boolean) => {
                if(isMainFrame) {
                    appWindow.window.webContents.send(`view-themeColor-updated-${this.id}`, GRAY_4)
                    appWindow.window.webContents.send(`view-blockedAds-updated-${this.id}`, 0)
                    
                    this.resetFavicon(url);
                }

                this.updateNavigationButtons()
            },
            viewStartedLoading: (_event: Electron.Event) => {                
                appWindow.window.webContents.send(`view-isBookmarked-updated-${this.id}`, false)
                appWindow.window.webContents.send(`view-error-updated-${this.id}`, undefined)
                appWindow.window.webContents.send(`view-status-updated-${this.id}`, 'loading')

                this.updateNavigationButtons()
            },
            viewStoppedLoading: (_event: Electron.Event) => {
                appWindow.window.webContents.send(`view-status-updated-${this.id}`, 'idle')

                this.updateNavigationButtons()
            },
            viewFinishedLoading: (_event: Electron.Event) => {
                this.addItemToHistory()

                 // todo: migrate old nedb code to sqlite
                // appWindow.storage.db.bookmarks.count({ url: this.url }, (e, count) => {
                //     appWindow.window.webContents.send(`view-isBookmarked-updated-${this.id}`, count >= 1)
                // })
            },
            viewWindowOpened: (
                _event: Electron.Event,
                url: string, 
                frameName: string, 
                disposition: "new-window" | "default" | "foreground-tab" | "background-tab" | "save-to-disk" | "other", 
                options: Electron.BrowserWindowConstructorOptions, 
                additionalFeatures: string[], 
                referrer: Electron.Referrer
            ) => {
                _event.preventDefault()

                if(disposition == "foreground-tab" || disposition == "background-tab") {
                    appWindow.window.webContents.send('add-tab', { url, active: disposition == "foreground-tab" })
                }
            },
            viewFailedLoading: (
                _event: Electron.Event, 
                errorCode: number, 
                errorDescription: string, 
                validatedURL: string, 
                isMainFrame: boolean, 
                frameProcessId: number, 
                frameRoutingId: number
            ) => {
                if(!isMainFrame || errorCode == -3 || validatedURL.startsWith(`${WEBUI_PREFIX}error${WEBUI_SUFFIX}`)) return;

                const error = { errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId };

                appWindow.window.webContents.send(`view-error-updated-${this.id}`, error)

                this.view.webContents.loadURL(`${WEBUI_PREFIX}error${WEBUI_SUFFIX}`)
                this.errorData = error
            },
            viewTitleUpdated: async (_event: Electron.Event, title: string) => {
                appWindow.window.webContents.send(`view-themeColor-updated-${this.id}`, BLUE_1)
                appWindow.window.webContents.send(`view-title-updated-${this.id}`, title)
            },
            viewFaviconUpdated: (_event: Electron.Event, favicons: any[]) => {
                if(this.url === NEWTAB_URL) return;
                const faviconUrl = favicons[0];

                if(faviconUrl == this.faviconURL) return;

                downloadFaviconFromUrl(faviconUrl).then((favicon: string) => {
                    if(this.favicon == favicon) return;

                    appWindow.window.webContents.send(`view-favicon-updated-${this.id}`, favicon)
                    this.favicon = favicon;
                    this.faviconURL = faviconUrl;

                    // this.cacheFavicon(favicon)
                })

                // this.updateNavigationButtons()
            }
        }
    }

    private updateNavigationButtons() {
        const canGoForward = this.view.webContents.canGoForward()
        const canGoBack = this.view.webContents.canGoBack()

        appWindow.window.webContents.send(`view-navigationStatus-updated-${this.id}`, { canGoForward, canGoBack })
    }

    private addItemToHistory() {
        const { url, title } = this;

        appWindow.storage.insert('history', {
            url,
            title,
            dateVisited: Date.now()
        })
    }

    private cacheFavicon(favicon) {
         // todo: migrate old nedb code to sqlite
        // const exists = appWindow.storage.db.favicons.find({ url: this.url }, (e, docs) => {
        //     return docs.length <= 1
        // })

        // if(exists) {
        //     appWindow.storage.db.favicons.update({
        //         url: this.url
        //     },
        //         favicon
        //     )
        // } else {
        //     appWindow.storage.db.favicons.insert([
        //         {
        //             url: this.url,
        //             base64: favicon
        //         }
        //     ])
        // }
    }

    private resetFavicon(url: string) {
        const { host } = parse(url)
        const currentHost = parse(this.url).host

        if(currentHost == host) return;

        this.favicon = null;
        appWindow.window.webContents.send(`view-favicon-updated-${this.id}`, null)
    }

    private updateZoomFactor() {
         // todo: migrate old nedb code to sqlite
        // this.view.webContents.zoomFactor = appWindow.storage.db.settings.getAllData()[0].appearance.pageZoom/100
    }

    public get url() {
        return this.view.webContents.getURL()
    }

    public get title() {
        return this.view.webContents.getTitle()
    }
}