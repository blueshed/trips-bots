import './main.css!';
import tmpl from './main-tmpl.html!text';
import Vue from 'vue';
import firebase_mixin from 'mixins/firebase-mixin';


Vue.component('work-panel', {
  	template: tmpl,
  	data: function(){
  		return {
	  		lat: 51.01,
	  		lng: 0.3
	  	};
  	},
  	props: [
  		"base"
  	],
  	methods:{
  		add: function(){
  			var fb = firebase_mixin(this.base);
  			var id = fb.methods.fb_add({
  				lat: parseFloat(this.lat), 
  				lng: parseFloat(this.lng)
  			});
  			this.lat=null;
  			this.lng=null;
  		}
  	}
});