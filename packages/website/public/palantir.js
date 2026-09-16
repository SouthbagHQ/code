/*
 * Palantir — Southbag's PostHog wiring. This file is identical in every Southbag
 * app; edit it in one place and copy it everywhere.
 *
 * Usage:
 *   <script src="/palantir.js" data-app="banking"
 *           data-user-id="…" data-user-email="…" data-user-name="…"
 *           data-session-url="/api/session"></script>
 *
 *   data-app          Name of the app (super property `southbag_app`).
 *   data-user-*       The signed-in user as the server knows them. Identifies immediately.
 *   data-session-url  Optional same-origin JSON endpoint returning `{ user: { id, email, name } }`
 *                     (or `{ authenticated: false }`) — used when the page has no data-user-*.
 *
 * When neither yields a user, Southbag Identity is asked directly: its session cookie
 * lives on `.southbag.cc`, so every Southbag app can resolve it with `credentials: "include"`.
 * A confirmed "no session" answer resets a stale identified profile back to anonymous.
 *
 * Custom events: `window.palantir.capture("event_name", { … })`.
 */
(function () {
	var script = document.currentScript;
	var ds = (script && script.dataset) || {};
	var IDENTITY = "https://identity.southbag.cc";

	// PostHog's loader stub (array.js). Queues calls until the real library loads.
	!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="ki Ci init qi Hi pr ji zi Di capture calculateEventProperties Qi register register_once register_for_session unregister unregister_for_session Ki getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Xi identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Ji Gi createPersonProfile setInternalOrTestUser Yi Ai rn opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Vi debug mr it getPageViewId captureTraceFeedback captureTraceMetric Oi".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

	function identify(user) {
		if (!user || !user.id) return;
		var props = {};
		if (user.email) props.email = user.email;
		if (user.name) props.name = user.name;
		window.posthog.identify(String(user.id), props);
	}

	function resetIfIdentified() {
		if (window.posthog.get_property("$user_state") === "identified") window.posthog.reset();
	}

	function sessionUser(url, credentials) {
		return fetch(url, { credentials: credentials, headers: { accept: "application/json" } })
			.then(function (response) {
				if (!response.ok) return undefined;
				return response.json();
			})
			.then(function (body) {
				if (body === undefined) return undefined; // couldn't ask — say nothing
				return body && body.user && body.user.id ? body.user : null; // null = confirmed signed out
			})
			.catch(function () {
				return undefined;
			});
	}

	function resolveUser() {
		if (ds.userId) {
			identify({ id: ds.userId, email: ds.userEmail, name: ds.userName });
			return;
		}
		var local = ds.sessionUrl ? sessionUser(ds.sessionUrl, "same-origin") : Promise.resolve(null);
		local
			.then(function (user) {
				if (user) return user;
				return sessionUser(IDENTITY + "/api/auth/get-session", "include");
			})
			.then(function (user) {
				if (user) identify(user);
				else if (user === null) resetIfIdentified();
			});
	}

	window.posthog.init("phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo", {
		api_host: "https://palantir.southbag.cc",
		ui_host: "https://us.posthog.com",
		defaults: "2026-05-30",
		person_profiles: "always",
		cross_subdomain_cookie: true,
		persistence: "localStorage+cookie",
		capture_pageview: "history_change",
		capture_pageleave: true,
		autocapture: true,
		capture_heatmaps: true,
		capture_dead_clicks: true,
		capture_exceptions: true,
		capture_performance: { network_timing: true, web_vitals: true },
		rageclick: true,
		enable_recording_console_log: true,
		disable_session_recording: false,
		session_recording: {
			maskAllInputs: false,
			maskTextSelector: null,
			recordCrossOriginIframes: true,
			recordHeaders: true,
			recordBody: true,
			recordCanvas: true,
		},
		loaded: function (ph) {
			ph.register({ southbag_app: ds.app || location.hostname });
			resolveUser();
		},
	});

	window.palantir = {
		capture: function (event, properties) {
			window.posthog.capture(event, properties);
		},
		identify: identify,
		reset: function () {
			window.posthog.reset();
		},
	};
})();
