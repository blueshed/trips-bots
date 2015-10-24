import './main.css!';
import tmpl from './main-tmpl.html!text';
import Vue from 'vue';
import Firebase from 'firebase';
import firebase_mixin from 'mixins/firebase-mixin';
import icon_map from './icon-map';



Vue.component('weather-panel', {
  	template: tmpl,
  	props: [
  		"base"
  	],
  	data: function(){
  		return {
  			weather_list: [],
  			weather_item: null
  		};
  	},
  	methods:{
  		open: function(item){
  			if(this.weather_item){
  				this.weather_item.fb_dispose();
  			}
  			var path = this.base + "/" + item.uid;
  			this.weather_item = new Vue({
  				data:{
  					location: null,
  					icon: null,
  					temperature: null,
  					raw: null
  				},
  				computed:{
            title: function(){
              if(this.location){
                return this.location;
              }
            },
            icon_class: function(){
              if(this.icon){
                return icon_map(this.icon);
              }
              return icon_map('default');
            }
  				},
  				mixins: [firebase_mixin(path)]
  			});
  			this.weather_item.fb_init();
  		},
  		get_weather: function(uid){
  			return this.weather_list.find(o => { return o.uid==uid; });
  		}
  	},
  	ready: function(){
  		var fb = new Firebase(this.base);
  		fb.on('value', value=>{});
  		fb.on("child_added", value => {
  			var node = this.get_weather(value.key());
  			if(!node){
				  this.weather_list.push({uid:value.key(),val: value.val()});
  			}
  		});
  		fb.on("child_changed", value => {
  			var node = this.get_weather(value.key());
  			if(node){
				  node.val = value.val();
  			}
  		});
  		fb.on("child_removed", value => {
  			var uid = value.key();
  			if(this.weather_item && this.weather_item.uid == uid){
  				this.weather_item = null;
  			}
  			this.weather_list.some( (o,i) => { 
  				if(o.uid==uid){
  					this.weather_list.splice(i,1);
            return true;
  				} 
  			});
  		});
  	}
});