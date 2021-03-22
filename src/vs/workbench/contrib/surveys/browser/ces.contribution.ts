/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { optional } from 'vs/platform/instantiation/common/instantiation';
import { language } from 'vs/base/common/platform';
import { IWorkbenchContributionsRegistry, IWorkbenchContribution, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { IProductService } from 'vs/platform/product/common/productService';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { Severity, INotificationService } from 'vs/platform/notification/common/notification';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITASExperimentService } from 'vs/workbench/services/experiment/common/experimentService';
import { URI } from 'vs/base/common/uri';
import { platform } from 'vs/base/common/process';
import { RunOnceScheduler } from 'vs/base/common/async';
import { Disposable } from 'vs/base/common/lifecycle';

const WAIT_TIME_TO_SHOW_SURVEY = 1000 * 60 * 60; // 1 hours
const MAX_INSTALL_AGE = 1000 * 60 * 60 * 24; // 24 hours
const REMIND_LATER_DELAY = 1000 * 60 * 60 * 4; // 4 hours
const SKIP_SURVEY_KEY = 'ces/skipSurvey';
const REMIND_LATER_DATE_KEY = 'ces/remindLaterDate';

class CESContribution extends Disposable implements IWorkbenchContribution {
	private promptScheduler!: RunOnceScheduler;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@optional(ITASExperimentService) private readonly tasExperimentService: ITASExperimentService,
	) {
		super();

		if (!productService.cesSurveyUrl) {
			return;
		}

		const skipSurvey = storageService.get(SKIP_SURVEY_KEY, StorageScope.GLOBAL, '');
		if (skipSurvey) {
			return;
		}
		this.promptScheduler = this._register(new RunOnceScheduler(async () => {
			const sendTelemetry = (userReaction: 'accept' | 'remindLater' | 'neverShowAgain') => {
				/* __GDPR__
				"cesSurvey:popup" : {
					"userReaction" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
				*/
				this.telemetryService.publicLog('cesSurvey:popup', { userReaction });
			};

			const message = await this.tasExperimentService?.getTreatment<string>('CESSurveyMessage') ?? nls.localize('cesSurveyQuestion', 'Got a moment to help the VS Code team? Please tell us about your experience with VS Code so far.');
			const button = await this.tasExperimentService?.getTreatment<string>('CESSurveyButton') ?? nls.localize('giveFeedback', "Give Feedback");

			this.notificationService.prompt(
				Severity.Info,
				message,
				[{
					label: button,
					run: () => {
						sendTelemetry('neverShowAgain');
						this.telemetryService.getTelemetryInfo().then(info => {
							this.openerService.open(URI.parse(`${this.productService.cesSurveyUrl}?o=${encodeURIComponent(platform)}&v=${encodeURIComponent(this.productService.version)}&m=${encodeURIComponent(info.machineId)}}`));
							this._skipSurvey();
						});
					}
				}, {
					label: nls.localize('remindLater', "Remind Me later"),
					run: () => {
						sendTelemetry('remindLater');
						this.storageService.store(REMIND_LATER_DATE_KEY, new Date().toUTCString(), StorageScope.GLOBAL, StorageTarget.USER);
						this._prepareSurvey();
					}
				}, {
					label: nls.localize('neverAgain', "Don't Show Again"),
					run: () => {
						sendTelemetry('neverShowAgain');
						this._skipSurvey();
					}
				}],
				{ sticky: true }
			);
		}, WAIT_TIME_TO_SHOW_SURVEY));

		this._prepareSurvey();
	}

	private async _prepareSurvey(): Promise<void> {
		const isCandidate = await this.tasExperimentService?.getTreatment<boolean>('CESSurvey');
		if (!isCandidate) {
			this._skipSurvey();
			return;
		}

		let waitTimeToShowSurvey = 0;
		const remindLaterDate = this.storageService.get(REMIND_LATER_DATE_KEY, StorageScope.GLOBAL, '');
		if (remindLaterDate) {
			const timeToRemind = new Date(remindLaterDate).getTime() + REMIND_LATER_DELAY - Date.now();
			if (timeToRemind > 0) {
				waitTimeToShowSurvey = timeToRemind;
			}
		} else {
			const info = await this.telemetryService.getTelemetryInfo();
			const timeFromInstall = Date.now() - new Date(info.firstSessionDate).getTime();
			const isNewInstall = !isNaN(timeFromInstall) && timeFromInstall < MAX_INSTALL_AGE;

			// Installation is older than MAX_INSTALL_AGE
			if (!isNewInstall) {
				this._skipSurvey();
				return;
			}
			if (timeFromInstall < WAIT_TIME_TO_SHOW_SURVEY) {
				waitTimeToShowSurvey = WAIT_TIME_TO_SHOW_SURVEY - timeFromInstall;
			}
		}
		this.promptScheduler.schedule(waitTimeToShowSurvey);
	}

	private _skipSurvey(): void {
		this.storageService.store(SKIP_SURVEY_KEY, this.productService.version, StorageScope.GLOBAL, StorageTarget.USER);
	}


}

if (language === 'en') {
	const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
	workbenchRegistry.registerWorkbenchContribution(CESContribution, LifecyclePhase.Restored);
}
