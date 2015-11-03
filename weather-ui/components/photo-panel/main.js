import './main.css!';
import 'dropzone/dist/min/basic.min.css!';
import tmpl from './main-tmpl.html!text';
import Vue from 'vue';
import Dropzone from 'dropzone';


Vue.component('photo-panel', {
  	template: tmpl,
  	data: function(){
  		return {};
  	},
  	props: [],
  	methods:{},
    ready: function(){
        this.$nextTick( () => {
            //this.$dropzone = new Dropzone("#my-awesome-dropzone", { url: "/upload"});
        });
    }
});
