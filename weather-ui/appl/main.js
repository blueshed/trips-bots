import 'jspm_packages/npm/skeleton-css@2.0.4/css/normalize.css!';
import 'jspm_packages/npm/skeleton-css@2.0.4/css/skeleton.css!';
import 'appl/main.css!';
import Vue from 'vue';

import 'components/weather-panel/main';
import 'components/work-panel/main';

Vue.config.debug = true

var FBPath = "https://popping-inferno-367.firebaseio.com/tests/";
var weather_base = FBPath + "weather";
var work_base = FBPath + "work";


var appl = window.appl = new Vue({
    el: ".main",
    data:{
        loading: true,
        welcome_msg: 'foobar',
        weather_base: weather_base,
        work_base: work_base
    },
    ready: function() {
        this.loading = false;
    }
});
